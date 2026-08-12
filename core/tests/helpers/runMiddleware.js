function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function createReq({
  method = 'GET',
  path = '/',
  headers = {},
  body = undefined,
  ip = '127.0.0.1'
} = {}) {
  const normalizedHeaders = normalizeHeaders(headers);

  return {
    app: { get: () => false },
    body,
    headers: normalizedHeaders,
    ip,
    method,
    originalUrl: path,
    path,
    get(name) {
      return normalizedHeaders[String(name).toLowerCase()];
    }
  };
}

function createRes(resolve) {
  const res = {
    body: undefined,
    headers: {},
    headersSent: false,
    locals: {},
    statusCode: 200,
    end(payload) {
      this.body = payload;
      this.headersSent = true;
      resolve(snapshot(this));
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      resolve(snapshot(this));
      return this;
    },
    removeHeader(name) {
      delete this.headers[String(name).toLowerCase()];
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      resolve(snapshot(this));
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    }
  };

  res.header = res.setHeader;
  res.set = res.setHeader;
  return res;
}

function snapshot(res) {
  return {
    body: res.body,
    headers: res.headers,
    status: res.statusCode
  };
}

function runMiddlewareChain(middlewares, reqOptions = {}) {
  return new Promise((resolve, reject) => {
    const req = createReq(reqOptions);
    let settled = false;
    let index = 0;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const res = createRes(finish);

    const next = err => {
      if (settled) return;
      if (err) {
        settled = true;
        reject(err);
        return;
      }

      const middleware = middlewares[index];
      index += 1;

      if (!middleware) {
        finish(snapshot(res));
        return;
      }

      try {
        const result = middleware(req, res, next);
        if (result && typeof result.then === 'function') {
          result.catch(reject);
        }
      } catch (caught) {
        reject(caught);
      }
    };

    next();
  });
}

function runMiddleware(middleware, reqOptions = {}) {
  return runMiddlewareChain([middleware], reqOptions);
}

module.exports = {
  createReq,
  runMiddleware,
  runMiddlewareChain
};
