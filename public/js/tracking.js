/* ============================================================
 * tracking.js - Camada de traqueamento da pagina de vendas
 *
 * O que faz:
 *  - Inicializa o Meta Pixel e o Google Analytics 4 (GA4)
 *  - Dispara cada evento DUAS vezes: no navegador (Pixel) e no
 *    servidor (CAPI), com o MESMO event_id -> deduplicacao.
 *  - Captura automaticamente _fbp, _fbc e fbclid (atribuicao Meta)
 *  - Mede PageView, profundidade de scroll e tempo na pagina
 *  - Permite disparar eventos via data-attributes no HTML
 *
 * Eventos suportados: PageView, ViewContent, InitiateCheckout,
 * AddPaymentInfo, Purchase, Lead (e qualquer custom).
 * ============================================================ */
(function () {
  'use strict';

  var CONFIG = window.TRACKING_CONFIG || {};
  var PIXEL_ID = CONFIG.metaPixelId || '';
  var GA4_ID = CONFIG.ga4MeasurementId || '';
  var CAPI_ENDPOINT = CONFIG.capiEndpoint || '/api/track';

  // ---------- Utilidades ----------

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  // Constroi o _fbc a partir do fbclid quando o cookie ainda nao existe.
  function resolveFbc() {
    var fbc = getCookie('_fbc');
    if (fbc) return fbc;
    var fbclid = getQueryParam('fbclid');
    if (fbclid) return 'fb.1.' + Date.now() + '.' + fbclid;
    return '';
  }

  // ---------- Inicializacao do Meta Pixel ----------

  function initMetaPixel() {
    if (!PIXEL_ID) return;
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    // PageView e disparado manualmente em track() para compartilhar event_id.
    window.fbq('init', PIXEL_ID);
  }

  // ---------- Inicializacao do GA4 ----------

  function initGA4() {
    if (!GA4_ID) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // send_page_view: false -> enviamos o page_view via track() para
    // manter o nome do evento alinhado entre as plataformas.
    window.gtag('config', GA4_ID, { send_page_view: false });
  }

  // ---------- Mapa de nomes Meta -> GA4 ----------
  // GA4 usa nomes de eventos recomendados diferentes dos da Meta.
  var GA4_EVENT_MAP = {
    PageView: 'page_view',
    ViewContent: 'view_item',
    InitiateCheckout: 'begin_checkout',
    AddPaymentInfo: 'add_payment_info',
    Purchase: 'purchase',
    Lead: 'generate_lead',
  };

  function toGA4Params(custom) {
    // Converte parametros estilo Meta para o padrao GA4 (ecommerce).
    var p = {};
    if (custom.currency) p.currency = custom.currency;
    if (custom.value != null) p.value = custom.value;
    if (custom.content_name) p.item_name = custom.content_name;
    if (custom.content_ids) p.item_id = [].concat(custom.content_ids).join(',');
    if (custom.order_id) p.transaction_id = custom.order_id;
    return p;
  }

  // ---------- Funcao central de disparo ----------

  /**
   * track(eventName, customData, userData)
   *  - eventName: 'Purchase', 'InitiateCheckout', etc.
   *  - customData: { value, currency, content_name, content_ids, order_id, ... }
   *  - userData: { em, ph, fn, ln, ... } (opcional; sera hasheado no servidor)
   */
  function track(eventName, customData, userData) {
    customData = customData || {};
    userData = userData || {};
    var eventId = uuid();

    // 1) Pixel (browser) com eventID para deduplicacao com a CAPI.
    if (window.fbq) {
      window.fbq('track', eventName, customData, { eventID: eventId });
    }

    // 2) GA4 (browser).
    if (window.gtag) {
      var ga4Name = GA4_EVENT_MAP[eventName] || eventName;
      window.gtag('event', ga4Name, toGA4Params(customData));
    }

    // 3) CAPI (servidor) com o MESMO event_id.
    var payload = {
      event_name: eventName,
      event_id: eventId,
      event_source_url: window.location.href,
      action_source: 'website',
      custom_data: customData,
      user_data: Object.assign({}, userData, {
        fbp: getCookie('_fbp'),
        fbc: resolveFbc(),
      }),
    };

    try {
      var blob = JSON.stringify(payload);
      // sendBeacon nao bloqueia a navegacao (ideal para clique em "comprar").
      if (navigator.sendBeacon) {
        navigator.sendBeacon(CAPI_ENDPOINT, new Blob([blob], { type: 'application/json' }));
      } else {
        fetch(CAPI_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: blob,
          keepalive: true,
        });
      }
    } catch (e) {
      /* falha silenciosa: nao quebrar a pagina por causa de tracking */
    }

    return eventId;
  }

  // ---------- Eventos automaticos ----------

  function trackScrollDepth() {
    var marks = [25, 50, 75, 90];
    var fired = {};
    function onScroll() {
      var h = document.documentElement;
      var scrolled = (h.scrollTop || document.body.scrollTop);
      var height = (h.scrollHeight - h.clientHeight) || 1;
      var pct = Math.round((scrolled / height) * 100);
      marks.forEach(function (m) {
        if (pct >= m && !fired[m]) {
          fired[m] = true;
          if (window.gtag) window.gtag('event', 'scroll_depth', { percent: m });
          if (window.fbq) window.fbq('trackCustom', 'ScrollDepth', { percent: m });
        }
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function trackTimeOnPage() {
    var marks = [15, 30, 60, 120]; // segundos
    marks.forEach(function (sec) {
      setTimeout(function () {
        if (window.gtag) window.gtag('event', 'time_on_page', { seconds: sec });
        if (window.fbq) window.fbq('trackCustom', 'TimeOnPage', { seconds: sec });
      }, sec * 1000);
    });
  }

  // ---------- Disparo por data-attributes ----------
  // Ex.: <a data-track-event="InitiateCheckout"
  //          data-value="197" data-currency="BRL"
  //          data-content-name="Curso X">Comprar</a>
  function wireDataAttributes() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-track-event]');
      if (!el) return;
      var eventName = el.getAttribute('data-track-event');
      var custom = {};
      if (el.dataset.value != null) custom.value = parseFloat(el.dataset.value);
      if (el.dataset.currency) custom.currency = el.dataset.currency;
      if (el.dataset.contentName) custom.content_name = el.dataset.contentName;
      if (el.dataset.contentIds) custom.content_ids = el.dataset.contentIds.split(',');
      if (el.dataset.orderId) custom.order_id = el.dataset.orderId;
      track(eventName, custom);
    });
  }

  // ---------- Bootstrap ----------

  function start() {
    initMetaPixel();
    initGA4();
    // PageView unico, compartilhado entre Pixel, GA4 e CAPI.
    track('PageView');
    trackScrollDepth();
    trackTimeOnPage();
    wireDataAttributes();
  }

  // API publica para disparos manuais (ex.: Purchase na pagina de obrigado).
  window.salesTracking = {
    track: track,
    purchase: function (data, user) { return track('Purchase', data, user); },
    initiateCheckout: function (data, user) { return track('InitiateCheckout', data, user); },
    addPaymentInfo: function (data, user) { return track('AddPaymentInfo', data, user); },
    lead: function (data, user) { return track('Lead', data, user); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
