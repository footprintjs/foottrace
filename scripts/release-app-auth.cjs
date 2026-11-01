'use strict';
const crypto = require('node:crypto');

/** Only the configured logical App read may receive this short-lived JWT. */
function appRequest(settings, method, route, body) {
  const refuse = () => {
    const error = new Error('app-auth');
    error.code = 'app-auth';
    throw error;
  };
  try {
    if (
      !settings ||
      typeof settings.slug !== 'string' ||
      !/^[a-z0-9-]+$/.test(settings.slug) ||
      typeof settings.clientId !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(settings.clientId) ||
      method !== 'GET' ||
      route !== `/apps/${settings.slug}` ||
      body !== undefined ||
      typeof settings.privateKey !== 'string' ||
      settings.privateKey.length > 65536
    )
      return refuse();
    const key = crypto.createPrivateKey(settings.privateKey);
    if (key.asymmetricKeyType !== 'rsa') return refuse();
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now <= 60) return refuse();
    const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({
      iat: now - 60,
      exp: now + 60,
      iss: settings.clientId,
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), {
      key,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return {
      url: 'https://api.github.com/app',
      authorization: `Bearer ${unsigned}.${signature.toString('base64url')}`,
      redirect: 'error',
    };
  } catch {
    return refuse();
  }
}
module.exports = { appRequest };
