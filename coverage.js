(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EcocityCoverage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ATTRIBUTION_KEYS = [
    'gclid',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
  ];
  const ENDPOINT_STATUSES = new Set(['eligible', 'ineligible', 'manual_review', 'error']);
  const ENDPOINT_REASONS = new Set([
    'region_with_pricelist_and_product', 'region_not_served', 'city_temporarily_excluded',
    'ambiguous_geocode', 'zero_or_multiple_regions', 'regional_exception',
    'product_unavailable', 'source_unavailable', 'input_invalid', 'rate_limited',
    'service_unavailable', 'origin_not_allowed', 'method_not_allowed',
  ]);
  const STATUS_REASON_PAIRS = {
    eligible: new Set(['region_with_pricelist_and_product']),
    ineligible: new Set(['region_not_served', 'city_temporarily_excluded']),
    manual_review: new Set([
      'ambiguous_geocode', 'zero_or_multiple_regions', 'regional_exception', 'product_unavailable',
      'source_unavailable', 'rate_limited', 'service_unavailable',
    ]),
    error: new Set(['input_invalid', 'origin_not_allowed', 'method_not_allowed']),
  };

  function normalizeCep(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 8);
  }

  function formatCep(value) {
    const cep = normalizeCep(value);
    return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
  }

  function validateCoverageInput(cepValue, numberValue) {
    if (normalizeCep(cepValue).length !== 8) return { ok: false, error: 'cep_invalido' };
    if (!String(numberValue || '').trim()) return { ok: false, error: 'numero_obrigatorio' };
    return { ok: true };
  }

  function normalizePlace(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function classifyCityGate() {
    return { status: 'manual_review', reason: 'odoo_required' };
  }

  function buildWhatsAppUrl({ phone, cep, number, city, requestId }) {
    const details = [
      `CEP ${formatCep(cep)}`,
      `número ${String(number || '').trim()}`,
      String(city || '').trim(),
      requestId ? `protocolo ${String(requestId).trim()}` : '',
    ].filter(Boolean).join(' — ');
    const message = [
      'Olá! Vim pelo site da Ecocity e quero um orçamento de caçamba.',
      `Dados para conferência: ${details}.`,
      'Precisamos confirmar a cobertura antes do orçamento.',
    ].join(' ');
    return `https://wa.me/${String(phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
  }

  function captureAttribution(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const result = {};
    for (const key of ATTRIBUTION_KEYS) {
      const value = params.get(key);
      if (value) result[key] = value.slice(0, 250);
    }
    return result;
  }

  function createRequestCoordinator() {
    let controller = null;
    let sequence = 0;
    return {
      start() {
        if (controller) controller.abort();
        controller = new AbortController();
        sequence += 1;
        return { controller, sequence };
      },
      isCurrent(candidate) {
        return candidate === sequence;
      },
    };
  }

  function normalizeRetryAfter(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(raw)) return null;
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : null;
  }

  async function checkCoverage({ apiUrl, cep, number, productCode, fetchImpl, signal, timeoutMs = 15000 }) {
    if (!String(apiUrl || '').trim()) {
      return { status: 'manual_review', reason: 'endpoint_not_configured' };
    }
    const request = {
      cep: normalizeCep(cep),
      numero: String(number || '').trim(),
    };
    if (productCode) request.product_code = String(productCode);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Number(timeoutMs) || 8000));
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const doFetch = fetchImpl || fetch;
      const response = await doFetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      let result;
      try {
        result = await response.json();
      } catch (_) {
        return { status: 'manual_review', reason: 'invalid_endpoint_response' };
      }
      if (result.persistent_writes !== 0 || typeof result.request_id !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(result.request_id)) {
        return { status: 'manual_review', reason: 'invalid_endpoint_response' };
      }
      if (!ENDPOINT_STATUSES.has(result.status) || !ENDPOINT_REASONS.has(result.reason)
        || !STATUS_REASON_PAIRS[result.status].has(result.reason)) {
        return { status: 'manual_review', reason: 'invalid_endpoint_response' };
      }
      if (Object.prototype.hasOwnProperty.call(result, 'partial_coverage') && !(
        result.status === 'manual_review' && result.reason === 'regional_exception' && result.partial_coverage === true
      )) {
        return { status: 'manual_review', reason: 'invalid_endpoint_response' };
      }
      if (response.status === 403 && result.status === 'error' && result.reason === 'origin_not_allowed') {
        return { ...result, http_status: 403 };
      }
      if (response.status === 422 && result.status === 'error' && result.reason === 'input_invalid') {
        return { ...result, http_status: 422 };
      }
      if (response.status === 429 && result.status === 'manual_review' && result.reason === 'rate_limited' && result.persistent_writes === 0) {
        const retryAfter = response.headers && response.headers.get ? response.headers.get('Retry-After') : null;
        return { ...result, http_status: 429, retry_after: normalizeRetryAfter(retryAfter) };
      }
      if (response.status === 503 && result.status === 'manual_review' && result.reason === 'source_unavailable' && result.persistent_writes === 0) {
        return { ...result, http_status: 503 };
      }
      if (!response.ok) return { status: 'manual_review', reason: 'endpoint_unavailable' };
      return result;
    } catch (_) {
      if (timedOut) return { status: 'manual_review', reason: 'request_timeout' };
      if (controller.signal.aborted) return { status: 'manual_review', reason: 'request_cancelled' };
      return { status: 'manual_review', reason: 'endpoint_unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkCoverageWhenEnabled({ enabled = false, isEnabled, cityResolver, ...options }) {
    const remainsEnabled = () => enabled === true
      && (typeof isEnabled !== 'function' || isEnabled() === true);
    if (!remainsEnabled()) {
      return { status: 'manual_review', reason: 'coverage_disabled' };
    }
    const result = await checkCoverage(options);
    if (!remainsEnabled()) {
      return { status: 'manual_review', reason: 'coverage_disabled' };
    }
    if (!result.city && result.reason !== 'request_cancelled' && typeof cityResolver === 'function') {
      const city = await cityResolver(options.cep, options.signal);
      if (!remainsEnabled()) {
        return { status: 'manual_review', reason: 'coverage_disabled' };
      }
      return { ...result, city };
    }
    return result;
  }

  return {
    normalizeCep,
    formatCep,
    validateCoverageInput,
    classifyCityGate,
    buildWhatsAppUrl,
    captureAttribution,
    checkCoverage,
    checkCoverageWhenEnabled,
    createRequestCoordinator,
  };
});
