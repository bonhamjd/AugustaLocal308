// Small key/value store on Netlify Blobs.
//
// This is the only place the site keeps its own data. It holds two things per
// member: a password hash, and a display name for bookings. Nothing else.
// Membership itself still lives in Stripe, so there is still no user table to
// keep in sync.
//
// Keys are a SHA-256 of the lowercased email, never the email itself, so the
// blob listing is not a member roster.
//
// connectLambda() is what lets these classic exports.handler functions reach
// Blobs. Every call passes the Lambda event through for that reason.

const crypto = require('crypto');

let blobs = null;
function lib() {
  if (!blobs) blobs = require('@netlify/blobs');
  return blobs;
}

// Tests set AL308_MEMORY_STORE=1 so the whole suite runs offline.
const memory = new Map();
function inMemory() {
  return process.env.AL308_MEMORY_STORE === '1';
}

function store(event) {
  const { connectLambda, getStore } = lib();
  if (event) {
    try {
      connectLambda(event);
    } catch (e) {
      /* already connected, or running outside Lambda */
    }
  }
  // Eventual consistency on purpose. Strong consistency needs an edge URL that
  // the Lambda-compatible runtime does not provide, and asking for it made every
  // read fail with "has not been configured with a 'uncachedEdgeURL' property".
  // The tradeoff is a propagation window of up to a minute, which nothing here
  // depends on: set-password hands back a session cookie, so a member is already
  // logged in and never has to race their own write.
  return getStore('al308');
}

function keyFor(email) {
  return crypto
    .createHash('sha256')
    .update(String(email || '').trim().toLowerCase())
    .digest('hex');
}

async function getJSON(event, key) {
  if (inMemory()) {
    return memory.has(key) ? JSON.parse(memory.get(key)) : null;
  }
  try {
    return await store(event).get(key, { type: 'json' });
  } catch (e) {
    console.error('[store] get failed for ' + key + ': ' + e.message);
    throw e;
  }
}

async function setJSON(event, key, value) {
  if (inMemory()) {
    memory.set(key, JSON.stringify(value));
    return;
  }
  await store(event).setJSON(key, value);
}

async function del(event, key) {
  if (inMemory()) {
    memory.delete(key);
    return;
  }
  try {
    await store(event).delete(key);
  } catch (e) {
    /* deleting something that is not there is not an error worth raising */
  }
}

// Convenience wrappers so functions do not repeat the key prefixes.
const authKey = (email) => 'auth/' + keyFor(email);
const throttleKey = (email) => 'throttle/' + keyFor(email);

async function getAuth(event, email) {
  return (await getJSON(event, authKey(email))) || null;
}

async function putAuth(event, email, record) {
  await setJSON(event, authKey(email), record);
}

module.exports = { keyFor, getJSON, setJSON, del, authKey, throttleKey, getAuth, putAuth, inMemory };
