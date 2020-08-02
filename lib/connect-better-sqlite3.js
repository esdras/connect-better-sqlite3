/**
 * Connect - SQLite3
 *
 *
 * Implementation of a Session Store using SQLite. This library
 * should be used in conjunction with the express-session library.
 *
 * This implementation uses better-sqlite3 to connect to SQLite.
 * All queries used by this library are compiled during initialization
 * using the db.prepare() function.
 *
 * Because SQLite is used, all data is stored in a file in the host of
 * the node process. This means that the data saved in one host will not
 * be available to others, unless you replicate the data yourself.
 *
 */

/**
 * @ignore
 */
const sqlite3 = require("better-sqlite3"),
  events = require("events"),
  path = require("path"),
  fs = require("fs");

const ONE_DAY = 86400000; // one day in milliseconds

/**
 * Return the a class used to instantiate the store
 *
 * @example
 *
 *    const session = require('express-session')
 *    const SQLiteStore = require('connect-better-sqlite3')(session)
 *
 *    const store = new SQLiteStore()
 *
 * @param   {object} session - Object exported by express-session
 * @return  {Function} Class used to instantiate a session store
 * @api     public
 */
module.exports = function(session) {
  const Store = session.Store;

  /**
   *
   * A default callback that throws if an error ocurred, returns data otherwise
   *
   */
  const defaultCb = (err, data) => {
    if (err) throw err;
    return data;
  };

  const noop = () => {};

  class SQLiteStore extends Store {
    /**
     *
     * @param {Object}  [ options = {} ]                          - Options used to unitialize the store
     * @param {string}  [ options.filename = 'sessions.sqlite3' ] - Path of the database file, pass ':memory:' to use an in-memory database
     * @param {string}  [ options.table = 'sessions' ]            - The name of the table used to store session data
     * @param {string}  [ options.dir = process.cwd() ]           - Directory of the database file
     * @param {string}  [ options.journal_mode = 'WAL' ]          - Pragma journal_mode, values may be 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF'
     * @param {string}  [ options.synchronous = 'NORMAL' ]        - Pragma synchronous, values may be 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'
     * @param {integer} [ options.ttl = 86400 ]                   - Session object ttl in seconds, defaults to one day
     * @param {Object}  [ options.serializer = JSON ]             - Session serializer, defaults to JSON
     */
    constructor(options = {}) {
      super(options);
      this.dir = options.dir || process.cwd();
      this.filename = options.filename || "sessions.sqlite3";
      this.table = options.table || "sessions";
      this.ttl = options.ttl || ONE_DAY;
      this.serializer = options.serializer || JSON;
      this.journal_mode = options.journal_mode || "WAL";
      this.synchronous = options.synchronous || "NORMAL";

      this.client = new events.EventEmitter();

      if (this.filename.indexOf(":memory:") > -1) this.dbPath = ":memory:";
      else this.dbPath = path.normalize(path.join(this.dir, this.filename));

      this.db = sqlite3(this.dbPath);
      this.db.pragma(`journal_mode = ${this.journal_mode}`);
      this.db.pragma(`synchronous = ${this.synchronous}`);

      this.createTableSQL = `

        CREATE TABLE IF NOT EXISTS ${this.table} (
          id PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          data BLOB
        );

        CREATE INDEX IF NOT EXISTS ${this.table}_expires_at ON ${this.table}(expires_at);

      `;

      this.dropTableSQL = `

        DROP TABLE IF EXISTS ${this.table};

      `;

      this.db.exec(this.createTableSQL);

      this.gcStmt = this.db.prepare(
        `DELETE FROM ${this.table} WHERE expires_at < ?`
      );
      this.getStmt = this.db.prepare(
        `SELECT data FROM ${this.table} WHERE id = ? AND expires_at >= ?`
      );
      this.setStmt = this.db.prepare(
        `INSERT OR REPLACE INTO ${this.table} (id, expires_at, data) VALUES (@id, @expires_at, @data)`
      );
      this.destroyStmt = this.db.prepare(
        `DELETE FROM ${this.table}  WHERE id = ?`
      );
      this.lengthStmt = this.db.prepare(
        `SELECT COUNT(id) FROM ${this.table} WHERE expires_at >= ?`
      );
      this.touchStmt = this.db.prepare(
        `UPDATE ${this.table} SET expires_at=? WHERE id=? AND expires_at >= ?`
      );
      this.allStmt = this.db.prepare(
        `SELECT data FROM ${this.table} WHERE expires_at >= ? ORDER BY id`
      );

      this.client.emit("connect");

      // collect garbage once a day
      this.interval = setInterval(this.gc.bind(this), ONE_DAY).unref();

      // close connection before exit
      process.on("exit", this.close.bind(this));
    }

    /**
     * The number active entries in the store; Active means that the entry didn't expire
     *
     * @param  {Function} [cb = defaultCb ] - a callback, the default callback returns de value or throws an exception
     * @return {number} the number of active sessions, may return something different depending on the callback
     *
     */
    length(cb = defaultCb) {
      const now = new Date().getTime();
      return cb(null, this.lengthStmt.pluck(true).get(now));
    }

    /**
     * Get a value from the store
     *
     * @param  {(number|String)} id - The id of the value
     * @param  {Function} [ cb = defaultCb ] - A callback that will receive the value, or an error if any occurs
     * @return {*} - Whatever is returned by the callback, de default callback returns retrieved from the Store.
     *
     */
    get(id, cb = defaultCb) {
      let result;

      try {
        const now = new Date().getTime();
        const data = this.getStmt.pluck(true).get(id, now);
        if (!data) return cb();
        result = this.serializer.parse(data);
      } catch (err) {
        return cb(err);
      }
      return cb(null, result);
    }

    /**
     * Put a value in the store
     *
     * @param {(number|string)} id - The id of the session
     * @param {*} sess - Any value that can be serialized by this.serializer
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called after the value is set
     * @return {*} Whatever is returned by the callback
     *
     */
    set(id, sess, cb = defaultCb) {
      let data;
      const now = new Date().getTime();
      const expires_at = now + this._getTTL(sess);

      try {
        data = this.serializer.stringify(sess);
        this.setStmt.run({ id, expires_at, data });
      } catch (err) {
        return cb(err);
      }
      return cb(null, undefined);
    }

    /**
     * Delete a value from the store
     *
     * @param {(number|string)} id - The id of the session
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called after the value is deleted
     * @return {*} Whatever is returned by the callback
     */
    destroy(id, cb = defaultCb) {
      try {
        this.destroyStmt.run(id);
      } catch (err) {
        return cb(err);
      }
      return cb(null, undefined);
    }

    /**
     * Delete everything that is in the store by droping and re-creating the sessions table
     *
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called after the store is cleared
     * @return {*} Whatever is returned by the callback
     */
    clear(cb = defaultCb) {
      try {
        this.db.exec(`

          BEGIN;

          ${this.dropTableSQL}

          ${this.createTableSQL}

          COMMIT;

        `);
      } catch (err) {
        return cb(err);
      }
      return cb(null, undefined);
    }

    /**
     * Touch an entry so that its expiration date is postponed.
     *
     * @param {(number|string)} id - The id of the session
     * @param {*} sess - The value of the session; Any value that can be serialized by this.serializer
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called after the value is touched
     * @return {*} Whatever is returned by the callback
     */
    touch(id, sess, cb = defaultCb) {
      try {
        let now = new Date().getTime();
        const ttl = this._getTTL(sess);
        const expires_at = now + ttl;
        this.touchStmt.run(expires_at, id, now);
      } catch (err) {
        return cb(err);
      }
      return cb(null, undefined);
    }

    /**
     * Fetch all values from the store and pass them to a callback
     *
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called with the array of values
     * @return {*} Whatever is returned by the callback
     */
    all(cb = defaultCb) {
      let all = [];
      try {
        let now = new Date().getTime();
        all = this.allStmt
          .pluck(true)
          .all(now)
          .map((s) => JSON.parse(s));
      } catch (err) {
        return cb(err);
      }
      return cb(null, all);
    }

    /**
     * Delete all expired values from the store.
     *
     * @return {undefined}
     *
     */
    gc() {
      let now = new Date().getTime();
      this.gcStmt.run(now);
    }

    /**
     * Returns the TTL of a value
     *
     * @private
     * @param {*} sess - The value of the session; Any value that can be serialized by this.serializer
     * @return {number} - the TTL value in milliseconds
     */
    _getTTL(sess) {
      let ttl;
      if (sess && sess.cookie && sess.cookie.maxAge) {
        ttl = sess.cookie.maxAge;
      } else {
        ttl = this.ttl;
      }
      return ttl;
    }

    close() {
      this.db.close();
    }

    /**
     * Delete database files, including journal files
     *
     * @param  {Function} [ cb = defaultCb ] - A callback that will be called with the array of values
     * @return {*} Whatever is returned by the callback
     */
    deleteDatabaseFile(cb = defaultCb) {
      try {
        this.db.close();
        if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
        if (fs.existsSync(`${this.dbPath}-journal`)) fs.unlinkSync(`${this.dbPath}-journal`);
        if (fs.existsSync(`${this.dbPath}-wal`)) fs.unlinkSync(`${this.dbPath}-wal`);
        if (fs.existsSync(`${this.dbPath}-shm`)) fs.unlinkSync(`${this.dbPath}-shm`);
      } catch (err) {
        if (err && err.code === "ENOENT")
          // ignore when files don't exist
          return cb();
        else return cb(err);
      }
      return cb();
    }
  }

  return SQLiteStore;
};
