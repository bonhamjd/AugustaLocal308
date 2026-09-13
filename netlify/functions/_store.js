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
  // Strong consistency: a member who just set a password must be able to log in
  // with it on the very next request, not up to 60 seconds later.
  return getStore({ name: 'al308', consistency: 'strong' });
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
    return await store(event).get(key, { type: 'json', consistency: 'strong' });
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
