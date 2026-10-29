(() => {
  const pending = new Map();
  let seq = 0, worker = null, failure = null;

  const banner = (msg) => {
    const el = document.createElement('div');
    el.className = 'fatal';
    el.textContent = msg;
    document.body.appendChild(el);
  };

  try {
    worker = new Worker(new URL('worker.js', document.currentScript.src), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, status, headers, body } = e.data;
      const done = pending.get(id);
      pending.delete(id);
      if (done) done(new Response(status === 204 ? null : body, { status, headers }));
    };
    worker.onerror = (e) => {
      failure = '계산 엔진을 시작하지 못했습니다. 최신 Chrome, Edge, Firefox, Safari에서 열어 주세요.';
      console.error(e);
      banner(failure);
    };
  } catch (e) {
    failure = '이 브라우저는 모듈 Web Worker를 지원하지 않습니다.';
    banner(failure);
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return nativeFetch(input, init);
    if (failure) throw new Error(failure);
    let body = init.body ?? null;
    const transfer = [];
    if (body instanceof Blob) { body = await body.arrayBuffer(); transfer.push(body); }
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, method: init.method || 'GET', url, body }, transfer);
    });
  };
})();
