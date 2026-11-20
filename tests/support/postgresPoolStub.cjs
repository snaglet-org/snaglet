/**
 * No-I/O `pg` stub for the unit:server Jest project.
 *
 * Unit suites occasionally reach the real `getDbClient()` facade through an
 * incidental side effect, but database behavior belongs in integration tests.
 * This module provides the node-postgres surface Snaglet constructs during that
 * path: restore recovery can confirm the fake target database exists, the
 * adapter can create a pool, and transaction callbacks can check out a client.
 * Nothing opens a socket or contacts a PostgreSQL server.
 */
'use strict';

const identityParser = (value) => value;

const parserRegistry = new Map();

const types = {
  builtins: {
    BOOL: 16,
    BYTEA: 17,
    CHAR: 18,
    INT8: 20,
    INT2: 21,
    INT4: 23,
    TEXT: 25,
    OID: 26,
    JSON: 114,
    FLOAT4: 700,
    FLOAT8: 701,
    VARCHAR: 1043,
    DATE: 1082,
    TIME: 1083,
    TIMESTAMP: 1114,
    TIMESTAMPTZ: 1184,
    INTERVAL: 1186,
    NUMERIC: 1700,
    UUID: 2950,
    JSONB: 3802,
  },
  setTypeParser(oid, formatOrParser, maybeParser) {
    const format = typeof formatOrParser === 'string' ? formatOrParser : 'text';
    const parser = typeof formatOrParser === 'function' ? formatOrParser : maybeParser;
    parserRegistry.set(`${oid}:${format}`, parser);
  },
  getTypeParser(oid, format = 'text') {
    return parserRegistry.get(`${oid}:${format}`) || identityParser;
  },
};

class TypeOverrides {
  constructor(defaultTypes = types) {
    this.defaultTypes = defaultTypes;
    this.parsers = new Map();
  }

  setTypeParser(oid, formatOrParser, maybeParser) {
    const format = typeof formatOrParser === 'string' ? formatOrParser : 'text';
    const parser = typeof formatOrParser === 'function' ? formatOrParser : maybeParser;
    this.parsers.set(`${oid}:${format}`, parser);
  }

  getTypeParser(oid, format = 'text') {
    return this.parsers.get(`${oid}:${format}`) || this.defaultTypes.getTypeParser(oid, format);
  }
}

function queryText(query) {
  return typeof query === 'string' ? query : (query && query.text) || '';
}

function resultFor(query) {
  const normalized = queryText(query).replace(/\s+/g, ' ').trim();
  let rows = [];

  // `recoverInterruptedPostgresRestore()` performs this probe before the
  // PostgresAdapter is published. Returning true models the already-existing
  // fake external database and keeps startup on its non-mutating fast path.
  if (normalized.includes('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)')) {
    rows = [{ present: true }];
  } else if (/^SELECT current_database\(\)/i.test(normalized)) {
    rows = [{ database: 'snaglet_unit_stub' }];
  } else if (/^SELECT 1 AS ok$/i.test(normalized)) {
    rows = [{ ok: 1 }];
  }

  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
}

function runQuery(query, values, callback) {
  const cb = typeof values === 'function' ? values : callback;
  const result = resultFor(query);
  if (typeof cb === 'function') {
    queueMicrotask(() => cb(null, result));
    return undefined;
  }
  return Promise.resolve(result);
}

class StubPoolClient {
  query(query, values, callback) {
    return runQuery(query, values, callback);
  }

  release() {}

  on() {
    return this;
  }
}

class Pool {
  constructor(options = {}) {
    this.options = options;
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
    this.ended = false;
  }

  on() {
    return this;
  }

  query(query, values, callback) {
    return runQuery(query, values, callback);
  }

  connect(callback) {
    const client = new StubPoolClient();
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, client, () => client.release()));
      return undefined;
    }
    return Promise.resolve(client);
  }

  end(callback) {
    this.ended = true;
    if (typeof callback === 'function') {
      queueMicrotask(() => callback());
      return undefined;
    }
    return Promise.resolve();
  }
}

module.exports = { Pool, TypeOverrides, types };
