const fs = require('fs')
const path = require('path')
const session = require('express-session')
const SQLiteStore = require('../index.js')(session)

const ONE_DAY = 86400000; // one day in milliseconds

var STORE = {};

function createStore(options) {
  STORE = new SQLiteStore(options)
  return STORE;
}

afterEach(() => {
  STORE.close();
  STORE.deleteDatabaseFile();
});


test('defaults', async () => {
  store = createStore()

  expect(store.dir).toEqual(process.cwd())
  expect(store.filename).toEqual('sessions.sqlite3')
  expect(store.table).toEqual('sessions')
  expect(store.ttl).toEqual(ONE_DAY)
  expect(store.serializer).toEqual(JSON)
  expect(store.journal_mode).toEqual('WAL')
  expect(store.synchronous).toEqual('NORMAL')


  // creates a SQLite database named sessions.sqlite3
  dbPath = path.join(process.cwd(), 'sessions.sqlite3')

  expect(fs.existsSync(dbPath)).toBeTruthy()

  // creates a sessions table
  const db = store.db
  const count = db
    .prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${store.table}'`)
    .pluck(true)
    .get()

  expect(count).toEqual(1)

  // correctly sets PRAGMA journal_mode and PRAGMA synchronous
  const [{ journal_mode }] = db.pragma('journal_mode')
  const [{ synchronous }] = db.pragma('synchronous')

  expect(journal_mode).toEqual('wal')
  expect(synchronous).toEqual(1)

  store.length((e, d) => expect(d).toEqual(0))

  await lifetimeTests(store)

})

test(':memory:', async () => {

  store = createStore({filename: ':memory:'})

  expect(store.filename).toEqual(':memory:')

  // in memory database does not create a file
  dbPath = path.join(process.cwd(), 'sessions.sqlite3')

  expect(fs.existsSync(dbPath)).toBeFalsy()

  await lifetimeTests(store)

})


test('other params', async () => {

  store  = createStore({
    filename: 'custom_session_db.sqlite3',
    table: 'custom_sessions_table',
    dir: __dirname,
    ttl: ONE_DAY * 2,
    journal_mode: 'TRUNCATE',
    synchronous: 'OFF'
  })

  expect(store.dir).toEqual(__dirname)
  expect(store.filename).toEqual('custom_session_db.sqlite3')
  expect(store.table).toEqual('custom_sessions_table')
  expect(store.ttl).toEqual(ONE_DAY * 2)
  expect(store.serializer).toEqual(JSON)
  expect(store.journal_mode).toEqual('TRUNCATE')
  expect(store.synchronous).toEqual('OFF')


  // creates a SQLite database named custom_session_db.sqlite3
  dbPath = path.join(__dirname, 'custom_session_db.sqlite3')

  expect(fs.existsSync(dbPath)).toBeTruthy()

  // creates a custom_sessions_table table
  const db = store.db
  const count = db
    .prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${store.table}'`)
    .pluck(true)
    .get()

  expect(count).toEqual(1)

  // correctly sets PRAGMA journal_mode and PRAGMA synchronous
  const [{ journal_mode }] = db.pragma('journal_mode')
  const [{ synchronous }] = db.pragma('synchronous')

  expect(journal_mode).toEqual('truncate')
  expect(synchronous).toEqual(0)

  store.length((e, d) => expect(d).toEqual(0))

  await lifetimeTests(store)


})

async function lifetimeTests(store) {

  store.set('foo', {data: 'bar'})

  // get by passing a callback
  store.get('foo', (e, d) => expect(d).toEqual({data: 'bar'}))

  // get by return value
  expect(store.get('foo')).toEqual({data: 'bar'})

  // we have 1 entry in the store
  store.length((e, d) => expect(d).toEqual(1))

  const q = store.db.prepare(`SELECT expires_at FROM ${store.table} WHERE id='foo'`)
  const expires_at = q.pluck(true).get()

  // await for 40 milliseconds
  await new Promise(resolve => setTimeout(resolve, 40));

  // touch store entry
  store.touch('foo')
  const touched_expires_at = q.pluck(true).get()

  expect(touched_expires_at).toBeGreaterThan(expires_at)

  // delete entry
  store.destroy('foo')

  store.get('foo', (e, d) => expect(d).toBeUndefined)

  store.length((e, d) => expect(d).toEqual(0))

  // set 'foo' to a different value
  store.set('foo', 42)
  store.set('bar', {name: 'Foo Fighters'})
  store.set('baz', {number: 25})

  store.get('foo', (e, d) => expect(d).toEqual(42))

  store.length((e, d) => expect(d).toEqual(3))

  store.all((e, d) => {
    expect(d).toEqual(expect.arrayContaining([42, {name: 'Foo Fighters'}, {number: 25}]))
  })

  // clear the store (this drops and re-creates the sessions table)
  store.clear()

  store.get('foo', (e, d) => expect(d).toBeUndefined)

  store.length((e, d) => expect(d).toEqual(0))

}