// UTM Tracker - Client-side tracking script
// Install: <script src="https://your-domain.com/tracking.js" data-api="https://your-api.com/api/track"></script>
(function() {
  'use strict';

  const scriptTag = document.currentScript || document.querySelector('script[src*="tracking.js"]');
  const API_URL = scriptTag?.dataset?.api || window.UTM_TRACKER_API || '/api/track';

  // Generate or retrieve visitor ID
  function getVisitorId() {
    let visitorId = localStorage.getItem('utm_visitor_id');
    if (!visitorId) {
      visitorId = 'v_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('utm_visitor_id', visitorId);
    }
    return visitorId;
  }

  // Generate session ID
  function getSessionId() {
    let sessionId = sessionStorage.getItem('utm_session_id');
    if (!sessionId) {
      sessionId = 's_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      sessionStorage.setItem('utm_session_id', sessionId);
    }
    return sessionId;
  }

  // Parse URL parameters
  function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get('utm_source'),
      utm_medium: params.get('utm_medium'),
      utm_campaign: params.get('utm_campaign'),
      utm_content: params.get('utm_content'),
      utm_term: params.get('utm_term'),
      campaign_id: params.get('campaign_id'),
      adgroup_id: params.get('adgroup_id'),
      ad_id: params.get('ad_id'),
      placement: params.get('placement'),
      creative_id: params.get('creative_id'),
      click_id: params.get('click_id') || params.get('fbclid') || params.get('gclid') || params.get('ttclid'),
      external_id: params.get('external_id')
    };
  }

  // Persist UTMs in localStorage (survives navigation)
  function persistUTMs(params) {
    const hasUTMs = Object.values(params).some(v => v !== null);
    if (hasUTMs) {
      const existing = JSON.parse(localStorage.getItem('utm_params') || '{}');
      const merged = { ...existing, ...Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== null)) };
      localStorage.setItem('utm_params', JSON.stringify(merged));
      return merged;
    }
    return JSON.parse(localStorage.getItem('utm_params') || '{}');
  }

  // Get device info
  function getDeviceInfo() {
    const ua = navigator.userAgent;
    let deviceType = 'desktop';
    if (/Mobile|Android|iPhone|iPad|iPod/.test(ua)) {
      deviceType = /iPad|Tablet/.test(ua) ? 'tablet' : 'mobile';
    }

    let browser = 'Unknown';
    if (/Chrome/.test(ua) && !/Edge/.test(ua)) browser = 'Chrome';
    else if (/Firefox/.test(ua)) browser = 'Firefox';
    else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
    else if (/Edge/.test(ua)) browser = 'Edge';

    let os = 'Unknown';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iOS|iPhone|iPad/.test(ua)) os = 'iOS';

    return { deviceType, browser, os, userAgent: ua };
  }

  // Send event to API
  async function sendEvent(eventType, eventData = {}) {
    try {
      const urlParams = getUrlParams();
      const persistedUTMs = persistUTMs(urlParams);
      const deviceInfo = getDeviceInfo();

      const payload = {
        visitor_id: getVisitorId(),
        session_id: getSessionId(),
        event_type: eventType,
        url: window.location.href,
        referrer: document.referrer,
        ...persistedUTMs,
        ...deviceInfo,
        ip_address: null, // Server will detect
        custom_params: eventData
      };

      // Use sendBeacon for reliability (doesn't block page unload)
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(API_URL, blob);
      } else {
        // Fallback to fetch
        fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => {});
      }
    } catch (e) {
      console.error('UTM Tracker error:', e);
    }
  }

  // Track page view
  function trackPageView() {
    sendEvent('page_view');
  }

  // Track click
  function trackClick(element, extraData = {}) {
    const data = {
      element_tag: element.tagName,
      element_text: element.textContent?.trim().substring(0, 100),
      element_href: element.href || null,
      ...extraData
    };
    sendEvent('click', data);
  }

  // Track custom event
  function trackEvent(eventName, data = {}) {
    sendEvent(eventName, data);
  }

  // Track lead
  function trackLead(data = {}) {
    sendEvent('lead', data);
  }

  // Track purchase
  function trackPurchase(data = {}) {
    sendEvent('purchase', data);
  }

  // Auto-track clicks on links and buttons
  function setupAutoTracking() {
    document.addEventListener('click', function(e) {
      const target = e.target.closest('a, button, [data-track]');
      if (target) {
        trackClick(target, {
          track_label: target.dataset.track || null
        });
      }
    }, true);
  }

  // Initialize
  function init() {
    // Track initial page view
    trackPageView();

    // Setup auto-tracking
    setupAutoTracking();

    // Track SPA navigation
    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        trackPageView();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Expose global API
    window.UTMTracker = {
      track: trackEvent,
      trackLead,
      trackPurchase,
      trackClick,
      getVisitorId,
      getSessionId,
      getUTMs: () => JSON.parse(localStorage.getItem('utm_params') || '{}')
    };

    console.log('✅ UTM Tracker initialized');
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();