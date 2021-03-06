'use strict';

const inq = require('inquirer');
const config = require('config');
const crypto = require('crypto');
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const Redis = require('ioredis');
const yargs = require('yargs');
const ipcMessageHandler = require('./discord/ipcMessage');
const { banner, setDefaultFont } = require('./discord/figletBanners');
const { PREFIX, replaceIrcEscapes, PrivmsgMappings, NetworkNotMatchedError, scopedRedisClient } = require('./util');
const userCommands = require('./discord/userCommands');
const { formatKVs, aliveKey, ticklePmChanExpiry, plotMpmData } = require('./discord/common');
const eventHandlers = require('./discord/events');

require('./logger')('discord');

const INTENTS = [
  Intents.FLAGS.GUILDS,
  Intents.FLAGS.GUILD_MESSAGES,
  Intents.FLAGS.DIRECT_MESSAGES,
  Intents.FLAGS.GUILD_MESSAGE_REACTIONS
];

const client = new Client({
  intents: INTENTS
});

const redisClient = new Redis(config.redis.url);
const categories = {};
const categoriesByName = {};
const channelsById = {};
const channelsByName = {};
const stats = {
  messages: {
    total: 0,
    ignored: 0,
    mentions: 0,
    types: {},
    channels: {}
  },
  messagesLastAnnounce: {},
  errors: 0,
  sinceLast: {
    quits: []
  },
  upSince: new Date(),
  lastAnnounce: new Date()
};

let _isReconnect = false;
function isReconnect () { return _isReconnect; }

let listenedTo = 0;
function _listenedToMutate (byVal) {
  listenedTo += byVal;
  client.user.setActivity(`${listenedTo} channels`, { type: 'LISTENING' });
}

const listenedToMutate = {
  addOne: _listenedToMutate.bind(null, 1),
  subOne: _listenedToMutate.bind(null, -1)
};

const oneTimeMsgHandlers = {};
function registerOneTimeHandler (event, discriminator, handlerFunc) {
  let discrimObj = oneTimeMsgHandlers[event];

  if (!discrimObj) {
    discrimObj = oneTimeMsgHandlers[event] = {};
  }

  if (!discrimObj[discriminator]) {
    discrimObj[discriminator] = [];
  }

  console.debug(`REG'ed OTH for ${event} discrim ${discriminator}`);
  discrimObj[discriminator].push(handlerFunc);
}

const channelMessageHandlers = {};
function registerChannelMessageHandler (channelId, handler) {
  channelMessageHandlers[channelId] = handler;
}

const buttonHandlers = {};
function registerButtonHandler (buttonId, handlerFunc) {
  if (!buttonHandlers[buttonId]) {
    buttonHandlers[buttonId] = [];
  }

  buttonHandlers[buttonId].push(handlerFunc);
}

const allowedSpeakersMentionString = (s = ['[', ']']) => s[0] + config.app.allowedSpeakers.map(x => `<@${x}>`).join(' ') + s[1];

let sendToBotChan = (...a) => console.error('sendToBotChan not initialized!', ...a);

const ignoreSquelched = [];

const captureSpecs = {};

if (config.capture.enabled) {
  console.log(`Capture enabled: running cleanup loop on ${config.capture.cleanupLoopFreqSeconds} second frequency`);
  setInterval(() => {
    const nowNum = Number(new Date());
    Object.entries(captureSpecs).forEach(([network, netSpec]) => {
      Object.entries(netSpec).forEach(([channelId, chanSpec]) => {
        if (chanSpec && chanSpec.exp > (nowNum / 100) && nowNum > chanSpec.exp) {
          console.log(`Capture spec cleanup loop expiring ${network}:${channelId}`, chanSpec);
          sendToBotChan(`\`SYSTEM\` Expiring channel capture for <#${channelId}> on \`${network}\` having captured ${chanSpec.captured} messages.`);
          delete captureSpecs[network][channelId];
        }
      });
    });
  }, config.capture.cleanupLoopFreqSeconds * 1000);
}

setDefaultFont(config.figletBanners.font);

console.log(`${PREFIX} Discord controller starting...`);

const formatForAllowedSpeakerResponse = (s, raw = false) =>
  (!raw
    ? s
    : (s instanceof MessageEmbed ? { embeds: [s] } : s));

client.once('ready', async () => {
  console.log('Ready!');

  client.user.setStatus('idle');
  client.user.setActivity('the IRC daemon...', { type: 'LISTENING' });

  const onExit = async (s) => {
    sendToBotChan('\n```\n' + (await banner(s)) + '\n```\n');
    client.user.setStatus('invisible');
    client.user.setActivity('nothing! (I\'m offline!)', { type: 'LISTENING' });
  };

  process.on('exit', () => {
    console.log('beforeExit!');
    onExit('Exit!');
  });

  process.on('SIGINT', () => {
    console.log('Exiting...');
    onExit('Bye!');
    setInterval(process.exit, 2000);
  });

  const chanCache = client.channels.cache.values();

  // first pass to build channelsById & categories
  for (const chan of chanCache) {
    channelsById[chan.id] = { name: chan.name, parent: chan.parentId };

    if (!chan.parentId) {
      console.log(`Found category '${chan.name}' with ID ${chan.id}`);
      categories[chan.id] = {
        name: chan.name,
        channels: {}
      };

      categoriesByName[chan.name] = chan.id;
      channelsByName[chan.name] = {};
    }
  }

  console.debug('FIRST PASS RES', categories);

  // second pass to build channels in categories
  for (const chan of client.channels.cache.values()) {
    const { id, name, parentId } = chan;
    if (chan.parentId && categories[chan.parentId]) {
      console.log(`Found channel ${chan.name} (ID ${chan.id}) in category '${categories[chan.parentId].name}'`);
      categories[chan.parentId].channels[chan.id] = { id, name, parentId, parent: parentId };
      channelsByName[categories[chan.parentId].name][chan.name] = chan.id;
    }
  }

  console.log('READY STRUCTS');
  console.log('channelsById', channelsById);
  console.log('categoriesByName', categoriesByName);
  // console.debug('categories', channelsById)

  if (config.irc.quitMsgChanId) {
    const __sendToBotChan = async (s, raw = false) => {
      if (!s || (typeof s === 'string' && !s?.length)) {
        console.error('sendToBotChan called without message!', s, raw);
        return;
      }

      let truncTail;
      if (!raw && s.length > config.discord.maxMsgLength) {
        console.error('MSG TOO LARGE -- TRUNCATING:');
        console.debug(s);
        truncTail = s.slice(config.discord.maxMsgLength - 50);
        s = s.slice(0, config.discord.maxMsgLength - 50) + ' [TRUNCATED]';
      }

      let toSend;
      try {
        // an admission that the `raw` flag was a terrible idea, because sometimes
        // callers don't use it but pass an object for `s` anyway. dammit.
        if (!raw && typeof s !== 'string') {
          console.debug(`sendToBotChan raw fixup: ${typeof s}`, s);
          s = '```json\n' + JSON.stringify(s, null, 2) + '\n```';
        }

        if (!raw) {
          s = replaceIrcEscapes(s);
        }

        toSend = formatForAllowedSpeakerResponse(s, raw);
        await client.channels.cache.get(config.irc.quitMsgChanId).send(toSend);
      } catch (e) {
        console.error('sendToBotChan .send() threw!', e);
        console.debug(s);
        ++stats.errors;

        setTimeout(() => sendToBotChan(`\`ERROR\` Discord send failure! "${e.message}"\n>>> ` + e.stack), 150);
      }

      return (truncTail ? sendToBotChan(truncTail, raw) : toSend);
    };

    // serialize bot-chan sends to a cadence of 1Hz, to avoid rate limits
    const stbcQueue = [];
    const stbcServicer = async () => {
      if (stbcQueue.length > 0) {
        const [s, raw] = stbcQueue.shift();
        await __sendToBotChan(s, raw);
      }

      setTimeout(stbcServicer, 1000);
    };

    sendToBotChan = async (s, raw = false) => stbcQueue.push([s, raw]);

    stbcServicer();
  }

  sendToBotChan('\n```\n' + (await banner('Hello!')) + '\n```\n\n');

  let allowedSpeakerCommandHandler = () => {
    throw new Error('allowedSpeakerCommandHandler not initialized! not configured?');
  };

  if (config.app.allowedSpeakers.length) {
    allowedSpeakerCommandHandler = async (data, toChanId) => {
      const trimContent = data.content.replace(/^\s+/, '');
      if (trimContent[0] === '!') {
        // allow |> as statement separators on a single line
        if (trimContent.indexOf('|>') !== -1) {
          const funcs = trimContent
            .split('|>')
            .map((s) => s.trim())
            .map((content) => allowedSpeakerCommandHandler.bind(null, { content }, toChanId));

          // serialize
          for (const f of funcs) {
            await f();
          }

          return;
        }

        const [command, ...args] = trimContent.slice(1).split(/\s+/);
        const fmtedCmdStr = '`' + `${command} ${args.join(' ')}` + '`';

        console.debug('USER CMD PARSED', command, fmtedCmdStr, args);
        const redis = new Redis(config.redis.url);

        try {
          const cmdFunc = userCommands(command);

          if (!cmdFunc) {
            console.warn('user comand not found! (silent to the user)', command, ...args);
            return;
          }

          const publish = async (publishObj) => redis.publish(PREFIX, JSON.stringify(publishObj));
          const argObj = yargs(args).help(false).exitProcess(false).argv;

          const createGuildChannel = async (channelName, channelOpts) =>
            client.guilds.cache.get(config.discord.guildId).channels.create(channelName, channelOpts);

          let localSender = sendToBotChan;

          if (toChanId) {
            localSender = async (msg, raw = false) => {
              let msgFormatted = formatForAllowedSpeakerResponse(msg, raw);
              const chan = client.channels.cache.get(toChanId);

              try {
                const _realSender = chan.__drcSend || chan.send.bind(chan);
                const privMsg = '_(Only visible to you)_';

                if (!raw) {
                  msgFormatted = `${privMsg} ${msgFormatted}`;
                }

                await _realSender(msgFormatted, raw);

                if (raw) {
                  await _realSender(privMsg);
                }
              } catch (err) {
                try {
                  console.warn('send failed, falling back to bot chan', err);
                  return await client?.channels.cache.get(config.irc.quitMsgChanId).send(msgFormatted);
                } catch (iErr) {
                  console.error('localSender/send failed!', iErr, toChanId, msg, chan);
                }
              }
            };
          }

          const result = await cmdFunc({
            stats,
            redis,
            publish, // TODO: replace all uses of `redis` with `publish` (and others if needed)
            sendToBotChan: localSender,
            argObj,
            options: argObj, // much better name! use this from now on...
            registerOneTimeHandler,
            createGuildChannel,
            registerChannelMessageHandler,
            registerButtonHandler,
            discordAuthor: data.author,
            ignoreSquelched,
            captureSpecs,
            channelsById,
            categoriesByName,
            toChanId,
            getDiscordChannelById: (id) => client.channels.cache.get(id)
          }, ...args);

          console.log(`Exec'ed user command ${command} with args [${args.join(', ')}] --> `, result);

          let toBotChan;
          if (result && result.__drcFormatter) {
            toBotChan = await result.__drcFormatter();
          } else if (typeof result === 'string') {
            toBotChan = result;
          } else if (result) {
            toBotChan = '```json\n' + JSON.stringify(result, null, 2) + '\n```\n';
          }

          if (toBotChan) {
            localSender(toBotChan);
          }
        } catch (ucErr) {
          console.error('user command threw!\n\n', ucErr);

          if (ucErr instanceof NetworkNotMatchedError) {
            sendToBotChan(`Unable to find a matching network for "${ucErr.message}"`);
          } else {
            sendToBotChan(fmtedCmdStr + `threw an error! (${ucErr.name}):` +
              ' `' + ucErr.message + '`');
          }
        } finally {
          redis.disconnect();
        }
      }
    };
  } else {
    delete eventHandlers.messageCreate;
  }

  const deletedBeforeJoin = {};
  const allowedSpeakersAvatars = [];
  const eventHandlerContext = {
    allowedSpeakersAvatars,
    sendToBotChan,
    channelMessageHandlers,
    client,
    allowedSpeakerCommandHandler,
    channelsById,
    categories,
    stats,
    deletedBeforeJoin,
    redisClient,
    redis: redisClient, // ugh
    registerButtonHandler,
    channelsByName,
    listenedToMutate,
    registerOneTimeHandler,
    buttonHandlers,
    publish: async (publishObj) => redisClient.publish(PREFIX, JSON.stringify(publishObj))
  };

  Object.entries(eventHandlers).forEach(([eventName, handler]) => {
    console.log(`Registered handler for event "${eventName}"`);
    client.on(eventName, (...a) => handler(eventHandlerContext, ...a));
  });

  const uCfg = await scopedRedisClient(async (redis) => userCommands('config')({ redis }, 'load'));

  if (uCfg.error) {
    sendToBotChan(`\nReloading user configuration failed:\n\n**${uCfg.error.message}**\n`);
    sendToBotChan('\nUsing default user configuration:\n\n' + formatKVs(config.user));
    console.warn('Reloading user config failed', uCfg.error);
  } else {
    sendToBotChan('\nUser configuration:\n\n' + formatKVs(uCfg));
  }

  console.log('Discovered private messaging category:', config.discord.privMsgCategoryId, channelsById[config.discord.privMsgCategoryId]);
  if (!config.discord.privMsgCategoryId || !channelsById[config.discord.privMsgCategoryId]) {
    const potentials = Object.keys(categoriesByName).filter(x => x.match(/priv(?:ate)?\s*me?s(?:sa)?ge?s?/ig) || x === 'PMs');

    if (potentials && potentials.length) {
      const emb = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.privMsg)
        .setTitle(`Discovered private message category "${potentials[0]}"`)
        .setDescription(`Category ID: ${categoriesByName[potentials[0]]}`)
        .addField('Channel inactivity removal time:', config.discord.privMsgChannelStalenessTimeMinutes + ' minutes');

      if (potentials.length > 1) {
        emb.addField('Also found the following potential categories', '...');
        potentials.slice(1).forEach((cName) => emb.addField(cName, categoriesByName[cName]));
      }

      await userCommands('config')({ redis: redisClient }, 'set', 'discord.privMsgCategoryId', categoriesByName[potentials[0]]);
      sendToBotChan(emb, true);
    }
  } else if (channelsById[config.discord.privMsgCategoryId]) {
    sendToBotChan(new MessageEmbed()
      .setColor(config.app.stats.embedColors.irc.privMsg)
      .setTitle(`Using private message category "${channelsById[config.discord.privMsgCategoryId].name}"`)
      .setDescription(`Category ID: ${config.discord.privMsgCategoryId}`)
      .addField('Channel inactivity removal time:', config.discord.privMsgChannelStalenessTimeMinutes + ' minutes'),
    true);
  } else {
    await userCommands('config')({ redis: redisClient }, 'set', 'discord.privMsgCategoryId', null);
    delete config.discord.privMsgCategoryId;
  }

  if (config.discord.privMsgCategoryId) {
    const toDel = Object.entries(channelsById).filter(([, { parent }]) => parent === config.discord.privMsgCategoryId);
    const realDel = await scopedRedisClient(async (aliveClient) => {
      const realDel = [];
      for (const [chanId, o] of toDel) {
        const network = PrivmsgMappings.findNetworkForKey(chanId);
        // only delete channels that have expired in Redis (assuming here that we've missed the keyspace notification for some reason)
        if (!(await aliveClient.get(aliveKey(network, chanId)))) {
          realDel.push([chanId, o]);
        }
      }
      return realDel;
    });

    if (realDel.length) {
      const rmEmbed = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.privMsg)
        .setTitle('Private Message channel cleanup')
        .setDescription('I removed the following stale private message channels:');

      for (const [chanId, { name }] of realDel) {
        console.log(`Removing old PM channel "${name}" ${chanId}`);
        rmEmbed.addField(name, chanId);
        await client.channels.cache.get(chanId).delete('discord.js startup');
      }

      await sendToBotChan(rmEmbed, true);
    }

    const privMsgExpiryListener = new Redis(config.redis.url);
    privMsgExpiryListener.on('pmessage', async (_chan, key, event) => {
      console.log('EXPIRY MSG', key, event);
      const [, prefix, type, trackingType, id, network] = key.split(':');

      if (prefix !== PREFIX) {
        stats.errors++;
        console.error(`bad prefix for keyspace notification! ${prefix}`, key, event);
        return;
      }

      if (event === 'expired') {
        if (type === 'pmchan') {
          if (trackingType === 'aliveness') {
            console.log(`PM channel ${id}:${network} expired! Removing...`);
            const chInfo = Object.entries(PrivmsgMappings.forNetwork(network)).find(([chId]) => chId == id)?.[1]; // eslint-disable-line eqeqeq
            if (!chInfo || !chInfo.target || !channelsById[id]) {
              console.error('bad chinfo?!', key, event, chInfo, channelsById[id], PrivmsgMappings.forNetwork(network));
              return;
            }

            if (channelsById[id].parent !== config.discord.privMsgCategoryId) {
              console.error('bad ch parent!?', key, event, channelsById[id].parent);
              return;
            }

            const toTime = Number(new Date());
            const queryArgs = [network, 'get', chInfo.target, `--from=${chInfo.created}`, `--to=${toTime}`];

            const rmEmbed = new MessageEmbed()
              .setColor(config.app.stats.embedColors.irc.privMsg)
              .setTitle('Private Message channel cleanup')
              .setDescription('I removed the following channel due to inactivity:')
              .addField(channelsById[id].name, 'Query logs for this session with:\n`' + `!logs ${queryArgs.join(' ')}` + '`');

            const buttonId = [id, crypto.randomBytes(8).toString('hex')].join('-');
            const actRow = new MessageActionRow()
              .addComponents(
                new MessageButton().setCustomId(buttonId).setLabel('Query logs').setStyle('SUCCESS')
              );

            registerButtonHandler(buttonId, async (interaction) => {
              const logs = await userCommands('logs')({
                registerOneTimeHandler,
                sendToBotChan,
                channelsById,
                network,
                publish: eventHandlerContext.publish,
                argObj: {
                  _: queryArgs
                },
                options: {
                  from: chInfo.created,
                  to: toTime
                }
              }, ...queryArgs);

              interaction.update({ embeds: [rmEmbed], components: [] });
              sendToBotChan(logs);
            });

            sendToBotChan(`:arrow_down: :rotating_light: :mega: ${allowedSpeakersMentionString(['', ''])}`);
            client.channels.cache.get(config.irc.quitMsgChanId).send({
              embeds: [new MessageEmbed()
                .setColor(config.app.stats.embedColors.irc.privMsg)
                .setTitle('Private Message channel cleanup')
                .setDescription('I removed the following channel due to inactivity:')
                .addField(channelsById[id].name, 'Query logs for this session with the button below or:\n`' + `!logs ${queryArgs.join(' ')}` + '`')],
              components: [actRow]
            });

            client.channels.cache.get(id).delete('stale');
            PrivmsgMappings.remove(network, id);
          } else if (trackingType === 'removalWarning') {
            try {
              const mins = JSON.parse(await redisClient.get(aliveKey(network, id)));

              const rmWarnEmbed = new MessageEmbed()
                .setColor('#ff0000')
                .setTitle('Inactivity removal warning!')
                .setDescription(`This channel has been inactive for **${mins.humanReadable.alertMins}** ` +
                  `and will be removed in **${mins.humanReadable.remainMins}** if it remains inactive!\n\n` +
                  `Click the button below to reset this countdown to **${mins.humanReadable.origMins}**.`);

              const buttonId = [id, crypto.randomBytes(8).toString('hex')].join('-');
              const actRow = new MessageActionRow()
                .addComponents(
                  new MessageButton().setCustomId(buttonId).setLabel('Reset countdown').setStyle('SUCCESS')
                );

              const warnMsg = await client.channels.cache.get(id).send({ embeds: [rmWarnEmbed], components: [actRow] });

              registerButtonHandler(buttonId, async (interaction) => {
                await ticklePmChanExpiry(network, id);
                interaction.update({
                  embeds: [new MessageEmbed()
                    .setColor('#00ff00')
                    .setTitle('Countdown reset')
                    .setDescription('This message will self-destruct in 1 minute...')],
                  components: []
                });
                setTimeout(() => warnMsg.delete().catch(console.error), 60 * 1000);
              });
            } catch (err) {
              stats.errors++;
              console.error('removalWarning KS notification threw', err);
            }
          }
        }
      } else {
        stats.errors++;
        console.error(`unknown keyspace event! key:${key} event: ${event}`);
      }
    });

    const ksKey = `__keyspace@${new URL(config.redis.url).pathname.replace('/', '')}*`;
    privMsgExpiryListener.psubscribe(ksKey);
    console.log(`Listening to expiry events on ${ksKey}`);
  }

  const mainSubClient = new Redis(config.redis.url);
  await mainSubClient.subscribe(PREFIX);

  const subscribedChans = {};
  const ircReady = {
    reject: (...a) => { throw new Error('ircReady not setup', a); },
    resolve: () => {}
  };

  ircReady.promise = new Promise((resolve, reject) => {
    const rr = (f, ...a) => {
      delete ircReady.reject;
      delete ircReady.resolve;
      f(...a);
    };

    ircReady.resolve = rr.bind(null, resolve);
    ircReady.reject = rr.bind(null, reject);
  });

  let ircHeartbeatListener;
  let ircHeartbeatHandle;
  const ircReadyHandler = async (readyRes) => {
    console.log('Got irc:ready!', readyRes);

    _isReconnect = readyRes && readyRes.isReconnect;

    if (readyRes.readyData) {
      const embed = new MessageEmbed()
        .setTitle('IRC is ready!')
        .setColor(config.app.stats.embedColors.irc.ready)
        .setDescription('Speaking as:')
        .addFields(...readyRes.readyData.map(x => ({ name: x.network, value: x.nickname, inline: true })))
        .setTimestamp();

      if (stats?.lastCalcs?.lagAsEmbedFields.length > 0) {
        embed.addField('Lag', '(in milliseconds)')
          .addFields(...stats.lastCalcs.lagAsEmbedFields);
      }

      sendToBotChan(embed, true);

      await scopedRedisClient(async (rClient) => {
        for (const { network } of readyRes.readyData) {
          const onConnectCmds = await userCommands('onConnect')({ redis: rClient }, network);

          for (const connectCmd of onConnectCmds) {
            console.log(await sendToBotChan(`Running connect command for \`${network}\`: \`${connectCmd}\``));
            await allowedSpeakerCommandHandler({ content: connectCmd });
          }
        }
      });
    } else {
      const embed = new MessageEmbed()
        .setColor(config.app.stats.embedColors.irc.ipcReconnect)
        .setTitle('IRC is reconnected!')
        .addFields(
          { name: 'IRC uptime', value: stats.irc?.uptime, inline: true },
          { name: 'Redis uptime', value: stats.lastCalcs?.redisUptime, inline: true },
          { name: 'System uptime', value: stats.lastCalcs?.systemUptime, inline: true },
          { name: 'Bot reconnects', value: String(stats.irc?.discordReconnects), inline: true },
          { name: 'Memory available', value: stats.lastCalcs?.memoryAvailablePercent + '%', inline: true },
          { name: 'Load averages', value: stats.sinceLast?.loadavg.join(', '), inline: true },
          { name: 'Redis clients', value: stats.redis.clients.connected_clients.toString(), inline: true }
        )
        .setTimestamp();

      if (stats?.lastCalcs?.lagAsEmbedFields.length > 0) {
        embed.addField('Lag', '(in milliseconds)')
          .addFields(...stats.lastCalcs.lagAsEmbedFields);
      }

      sendToBotChan(embed, true);
    }

    if (!readyRes || !readyRes.isReconnect) {
      redisClient.publish(PREFIX, JSON.stringify({
        type: 'discord:channels',
        data: { categories, channelsById, categoriesByName }
      }));
    } else {
      console.log('Re-connected!');
    }

    const HB_FUDGE_FACTOR = 1.01;
    let ircLastHeartbeat = Number(new Date());
    ircHeartbeatListener = new Redis(config.redis.url);
    ircHeartbeatListener.on('message', (...a) => {
      const nowNum = Number(new Date());
      if (nowNum - ircLastHeartbeat > (config.irc.heartbeatFrequencyMs * HB_FUDGE_FACTOR)) {
        console.error('ircHeartbeatListener IRC heartbeat is late!', nowNum - ircLastHeartbeat);
      }
      ircLastHeartbeat = nowNum;
    });
    let numLates = 0;
    ircHeartbeatHandle = setInterval(() => {
      if (Number(new Date()) - ircLastHeartbeat > (config.irc.heartbeatFrequencyMs * HB_FUDGE_FACTOR)) {
        console.error('IRC heartbeat is late!', Number(new Date()) - ircLastHeartbeat);
        if (++numLates > 3) {
          const msg = `Looks like we lost IRC! Last hearbeat was ${Number(new Date()) - ircLastHeartbeat}ms ago (${numLates})`;
          console.error(msg);
          sendToBotChan(msg);
          clearInterval(ircHeartbeatHandle);
          ircHeartbeatListener.disconnect();
        }
      } else {
        numLates = 0;
      }
    }, config.irc.heartbeatFrequencyMs);
    ircHeartbeatListener.subscribe(PREFIX + ':heartbeats:irc');

    client.user.setStatus('online');
  };

  const runOneTimeHandlersMatchingDiscriminator = async (type, data, discrim) => {
    console.debug('runOneTimeHandlersMatchingDiscriminator', type, discrim, data, oneTimeMsgHandlers);
    if (oneTimeMsgHandlers[type] && oneTimeMsgHandlers[type][discrim]) {
      try {
        for (const hfunc of oneTimeMsgHandlers[type][discrim]) {
          await hfunc(data);
        }
      } catch (e) {
        console.error(`OTH for ${type}/${discrim} failed!`, e);
      }

      delete oneTimeMsgHandlers[type][discrim];

      if (!Object.keys(oneTimeMsgHandlers[type]).length) {
        delete oneTimeMsgHandlers[type];
      }
    }
  };

  mainSubClient.on('message', ipcMessageHandler.bind(null, {
    allowedSpeakersAvatars,
    stats,
    runOneTimeHandlersMatchingDiscriminator,
    registerButtonHandler,
    sendToBotChan,
    ircReady,
    ircReadyHandler,
    client,
    channelsById,
    captureSpecs,
    allowedSpeakersMentionString,
    subscribedChans,
    listenedToMutate,
    categories,
    categoriesByName,
    channelsByName,
    allowedSpeakerCommandHandler,
    isReconnect,
    setIsReconnect: (s) => (_isReconnect = s)
  }));

  try {
    redisClient.publish(PREFIX, JSON.stringify({
      type: 'discord:startup',
      data: { categories, channelsById, categoriesByName }
    }));

    console.log('Waiting for irc:ready...');
    sendToBotChan('Waiting for IRC bridge...');
    const readyRes = await ircReady.promise;
    _isReconnect = readyRes?.isReconnect;

    await userCommands('stats')({
      stats,
      options: {
        reload: true,
        silent: true
      },
      registerOneTimeHandler,
      redis: redisClient,
      publish: (o) => redisClient.publish(PREFIX, JSON.stringify(o))
    });

    await ircReadyHandler(readyRes);

    const _persist = async () => {
      console.log(`Auto-persisting stats at ${config.app.statsSilentPersistFreqMins}-minute frequency`);
      await scopedRedisClient(async (redis) => {
        await userCommands('stats')({
          stats,
          options: {
            silent: true
          },
          registerOneTimeHandler,
          redis,
          publish: (o) => redis.publish(PREFIX, JSON.stringify(o))
        });

        const { chatMsgsMpm, totMsgsMpm } = stats.lastCalcs;
        await redis.lpush(`${PREFIX}:mpmtrack`, JSON.stringify({
          chatMsgsMpm,
          totMsgsMpm,
          timestamp: Number(new Date())
        }));

        await plotMpmData();
      });
    };

    const silentStatsPersist = () => {
      if (config.app.statsSilentPersistFreqMins) {
        setTimeout(() => {
          _persist();
          silentStatsPersist();
        }, config.app.statsSilentPersistFreqMins * 60 * 1000);
      }
    };

    silentStatsPersist();
  } catch (err) {
    console.error('Ready handshake failed!', err);
  }
});

['error', 'debug', 'userUpdate', 'warn', 'presenceUpdate', 'shardError', 'rateLimit'].forEach((eName) => {
  client.on(eName, async (...a) => {
    console.debug({ event: eName }, ...a);
    if (eName === 'error' || eName === 'warn' || eName === 'rateLimit') {
      let msg = `Discord PROBLEM <${eName}>: ` + '```json\n' + JSON.stringify([...a], null, 2) + '\n```\n';

      if (eName === 'rateLimit') {
        const [_, rootPath, id] = a[0].path.split('/'); // eslint-disable-line no-unused-vars
        console.log(rootPath, 'RL!!', a[0], a[0].path, id, channelsById[id]);
        if (rootPath === 'webhooks') {
          const wh = await client.fetchWebhook(id);
          if (wh.channelId && channelsById[wh.channelId]) {
            msg += 'Channel:```json\n' + JSON.stringify(channelsById[wh.channelId], null, 2) + '\n```\n';
          }
          msg += 'Webhook:```json\n' + JSON.stringify(wh, null, 2) + '\n```\n';
        } else if (channelsById[id]) {
          msg += 'Channel:```json\n' + JSON.stringify(channelsById[id], null, 2) + '\n```\n';
        }
      }

      sendToBotChan(msg);
      console.error(msg);
      ++stats.errors;
    }
  });
});

async function main () {
  let { token } = config.discord;

  if (!token) {
    token = (await inq.prompt({
      type: 'password',
      name: 'token',
      message: `Enter token for bot with ID ${config.discord.botId}`
    })).token;
  }

  client.login(token);
}

main();
