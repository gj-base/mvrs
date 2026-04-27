/**
 * 내부 클라우드용: Supabase JS와 유사한 최소 API (auth / from 체인 / rpc / functions.invoke)
 * — Nest 백엔드(/api)와 통신합니다. 루트 프로젝트(Supabase)용 파일은 수정하지 마세요.
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'mvrs_access_token';
  var USER_KEY = 'mvrs_user_json';

  function baseUrl() {
    var b =
      (typeof global.MVRS_API_BASE !== 'undefined' && global.MVRS_API_BASE) ||
      (typeof global.MVRS_API_BASE_URL !== 'undefined' && global.MVRS_API_BASE_URL);
    if (b == null || String(b).trim() === '') {
      b = '/api';
    }
    return String(b).replace(/\/$/, '');
  }

  function authHeader() {
    var h = {};
    try {
      var tok = global.sessionStorage && global.sessionStorage.getItem(TOKEN_KEY);
      if (tok) {
        h.Authorization = 'Bearer ' + tok;
      }
    } catch (e) {}
    return h;
  }

  async function apiFetch(path, options) {
    var opts = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeader(), opts.headers || {});
    var init = {
      method: opts.method || 'GET',
      headers: headers,
    };
    if (opts.body != null) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    var r = await global.fetch(baseUrl() + path, init);
    return r;
  }

  function makeInvokeError(message, status, response) {
    var err = new Error(message || 'invoke failed');
    err.context = response || { status: status };
    return err;
  }

  function TableQuery(client, table) {
    this._client = client;
    this._table = table;
    this._op = 'select';
    this._columns = '*';
    this._filters = [];
    this._orders = [];
    this._limit = null;
    this._patch = null;
    this._single = null;
  }

  TableQuery.prototype.select = function (cols) {
    this._columns = cols != null ? String(cols) : '*';
    return this;
  };

  TableQuery.prototype.insert = function () {
    throw new Error('insert는 내부 API에서 직접 지원하지 않습니다. submit-reservation 등을 사용하세요.');
  };

  TableQuery.prototype.update = function (patch) {
    this._op = 'update';
    this._patch = patch || {};
    return this;
  };

  TableQuery.prototype.delete = function () {
    this._op = 'delete';
    return this;
  };

  TableQuery.prototype.eq = function (col, val) {
    this._filters.push({ type: 'eq', col: col, val: val });
    return this;
  };

  TableQuery.prototype.neq = function (col, val) {
    this._filters.push({ type: 'neq', col: col, val: val });
    return this;
  };

  TableQuery.prototype.in = function (col, vals) {
    this._filters.push({ type: 'in', col: col, val: vals });
    return this;
  };

  TableQuery.prototype.order = function (col, opts) {
    var asc = !opts || opts.ascending !== false;
    this._orders.push({ col: col, asc: asc });
    return this;
  };

  TableQuery.prototype.limit = function (n) {
    this._limit = n;
    return this;
  };

  TableQuery.prototype.single = function () {
    this._single = 'single';
    return this;
  };

  TableQuery.prototype.maybeSingle = function () {
    this._single = 'maybe';
    return this;
  };

  TableQuery.prototype.then = function (onFulfilled, onRejected) {
    return this._execute().then(onFulfilled, onRejected);
  };

  TableQuery.prototype.catch = function (onRejected) {
    return this._execute().catch(onRejected);
  };

  TableQuery.prototype._execute = function () {
    var self = this;
    return (async function () {
      var res = await apiFetch('/db/query', {
        method: 'POST',
        body: {
          table: self._table,
          op: self._op,
          columns: self._columns,
          filters: self._filters,
          orders: self._orders,
          limit: self._limit,
          patch: self._patch,
          single: self._single,
        },
      });
      var text = await res.text();
      var j = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch (e) {
        return { data: null, error: { message: text || 'Invalid JSON' } };
      }
      if (!res.ok) {
        return {
          data: null,
          error: { message: (j && (j.message || j.error)) || res.statusText || String(res.status) },
        };
      }
      if (j && j.error) {
        return { data: null, error: { message: String(j.error) } };
      }
      return { data: j.data !== undefined ? j.data : j, error: null };
    })();
  };

  function MvrsCompatClient() {
    var client = this;
    this._authListeners = [];

    this.auth = {
      getSession: async function () {
        try {
          var tok = global.sessionStorage && global.sessionStorage.getItem(TOKEN_KEY);
          if (!tok) {
            return { data: { session: null }, error: null };
          }
          var res = await apiFetch('/auth/session', { method: 'GET' });
          var j = await res.json().catch(function () {
            return null;
          });
          if (!res.ok || !j || !j.user) {
            try {
              global.sessionStorage.removeItem(TOKEN_KEY);
              global.sessionStorage.removeItem(USER_KEY);
            } catch (e2) {}
            return { data: { session: null }, error: null };
          }
          var session = {
            access_token: tok,
            token_type: 'bearer',
            user: j.user,
          };
          return { data: { session: session }, error: null };
        } catch (e) {
          return { data: { session: null }, error: { message: String(e.message || e) } };
        }
      },

      signInWithPassword: async function (creds) {
        var email = creds && creds.email ? String(creds.email).trim() : '';
        var password = creds && creds.password != null ? String(creds.password) : '';
        var res = await apiFetch('/auth/sign-in', {
          method: 'POST',
          body: { email: email, password: password },
          headers: {},
        });
        var j = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          var msg401 = (j && j.message) || '로그인에 실패했습니다.';
          if (Array.isArray(msg401)) msg401 = msg401[0] || '로그인에 실패했습니다.';
          return {
            data: { user: null, session: null },
            error: { message: String(msg401) },
          };
        }
        try {
          global.sessionStorage.setItem(TOKEN_KEY, j.access_token);
          global.sessionStorage.setItem(USER_KEY, JSON.stringify(j.user || {}));
        } catch (e) {}
        var session = {
          access_token: j.access_token,
          token_type: 'bearer',
          user: j.user,
        };
        return { data: { user: j.user, session: session }, error: null };
      },

      signUp: async function (creds) {
        var email = creds && creds.email ? String(creds.email).trim() : '';
        var password = creds && creds.password != null ? String(creds.password) : '';
        var options = (creds && creds.options) || {};
        var res = await apiFetch('/auth/sign-up', {
          method: 'POST',
          body: {
            email: email,
            password: password,
            data: (options && options.data) || {},
          },
        });
        var j = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          return {
            data: { user: null, session: null },
            error: { message: (j && j.message) || '가입에 실패했습니다.' },
          };
        }
        if (j.access_token) {
          try {
            global.sessionStorage.setItem(TOKEN_KEY, j.access_token);
            global.sessionStorage.setItem(USER_KEY, JSON.stringify(j.user || {}));
          } catch (e) {}
          var session2 = {
            access_token: j.access_token,
            token_type: 'bearer',
            user: j.user,
          };
          return { data: { user: j.user, session: session2 }, error: null };
        }
        return { data: { user: j.user || null, session: null }, error: null };
      },

      signOut: async function () {
        try {
          global.sessionStorage.removeItem(TOKEN_KEY);
          global.sessionStorage.removeItem(USER_KEY);
        } catch (e) {}
        return { error: null };
      },

      onAuthStateChange: function (callback) {
        client._authListeners.push(callback);
        setTimeout(function () {
          client.auth.getSession().then(function (res) {
            var s = res && res.data && res.data.session;
            try {
              callback('INITIAL_SESSION', s);
            } catch (e) {}
          });
        }, 0);
        return {
          data: {
            subscription: {
              unsubscribe: function () {
                var idx = client._authListeners.indexOf(callback);
                if (idx >= 0) {
                  client._authListeners.splice(idx, 1);
                }
              },
            },
          },
        };
      },
    };
  }

  MvrsCompatClient.prototype._notifyAuth = function (evt, session) {
    for (var i = 0; i < this._authListeners.length; i++) {
      try {
        this._authListeners[i](evt, session);
      } catch (e) {}
    }
  };

  MvrsCompatClient.prototype.from = function (table) {
    return new TableQuery(this, table);
  };

  MvrsCompatClient.prototype.rpc = function (fn, args) {
    return (async function () {
      var res = await apiFetch('/rpc/' + encodeURIComponent(fn), {
        method: 'POST',
        body: args || {},
      });
      var text = await res.text();
      var j = text ? JSON.parse(text) : null;
      if (!res.ok) {
        return { data: null, error: { message: (j && j.message) || text || String(res.status) } };
      }
      if (j && j.error) {
        return { data: null, error: { message: String(j.error) } };
      }
      return { data: j.data, error: null };
    })();
  };

  MvrsCompatClient.prototype.functions = {
    invoke: async function invokeFn(name, opts) {
      var body = (opts && opts.body) || {};
      var headers = Object.assign({}, (opts && opts.headers) || {});
      var res = await apiFetch('/functions/' + encodeURIComponent(name), {
        method: 'POST',
        body: body,
        headers: headers,
      });
      var text = await res.text();
      var j = null;
      try {
        j = text ? JSON.parse(text) : {};
      } catch (e) {
        return {
          data: null,
          error: makeInvokeError(text || 'Invalid JSON', res.status, res),
        };
      }
      if (!res.ok) {
        return {
          data: j,
          error: makeInvokeError((j && (j.error || j.message)) || res.statusText, res.status, res),
        };
      }
      return { data: j, error: null };
    },
  };

  /** createClient(url, key) — 인자는 호환용으로 무시합니다. */
  function createClient() {
    return new MvrsCompatClient();
  }

  global.supabase = Object.assign({}, global.supabase || {}, { createClient: createClient });
})(typeof window !== 'undefined' ? window : this);
