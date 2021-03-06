'use strict';

const { shodanHostLookup, matchNetwork, scopedRedisClient } = require('../../util');
const { PREFIX } = require('../../util');

module.exports = async function (context, ...a) {
  if (a.length < 2) {
    throw new Error('not enough args');
  }

  if (context.argObj?.nmap && typeof context.argObj?.nmap === 'string') {
    context.argObj.nmap = context.argObj.nmap.split(/\s+/g);
  }

  // for when '!whois' is issued from a normal channel, rather than as a reaction
  // (which already adds channel ID to the `a` array in messageReactionAdd.js)
  if (context.toChanId && a.length === 2) {
    a.push(context.toChanId);
  }

  const [netStub, nick, channel] = a;
  const { network } = matchNetwork(netStub);

  const reqObj = {
    type: 'discord:requestWhois:irc',
    data: {
      network,
      nick,
      channel,
      options: context.argObj
    }
  };

  if (reqObj.data.options?.nmap) {
    if (typeof reqObj.data.options.nmap === 'number') {
      reqObj.data.options.nmap = `${reqObj.data.options.nmap}`;
    }

    if (typeof reqObj.data.options.nmap === 'string') {
      reqObj.data.options.nmap = reqObj.data.options.nmap.split(/\s+/g);
    }
  }

  if (reqObj.data.options?.shodan) {
    context.registerOneTimeHandler('irc:responseWhois:full', `${network}_${nick}`, async (data) => {
      await scopedRedisClient(async (r) => r.publish(PREFIX, JSON.stringify({
        type: 'discord:shodan:host',
        data: await shodanHostLookup(data.hostname)
      })));
    });
  }

  console.debug('whois PUB', reqObj);
  await context.publish(reqObj);
};
