/* =====================================================================
   /dashboard/ — public, no-login analytics for pumpkinpatchesnearme.com.
   Reads aggregate RPCs (see supabase/migrations/) with the anon key and
   subscribes to Supabase Realtime for the live activity panel. There is
   no server here — everything below runs in the browser, gated entirely
   by the table's RLS policies (public read) rather than by auth.

   Charts are hand-rolled inline SVG rather than a charting library: this
   is a static site with no bundler, and pulling in a full chart library
   just for two simple charts isn't worth the extra request weight.
   ===================================================================== */
(function () {
  'use strict';

  var config = window.__PPNM_ANALYTICS__ || {};
  var warningEl = document.getElementById('dash-config-warning');
  var appEl = document.getElementById('dash-app');
  if (!appEl) return;

  if (!config.url || !config.anonKey || !config.table || !window.supabase) {
    if (warningEl) warningEl.hidden = false;
    return;
  }

  var client = window.supabase.createClient(config.url, config.anonKey);
  var TABLE = config.table;
  var currentRange = 30;
  var liveCount = 0;

  var ACTION_COLORS = {
    pageview: '#f26a21',
    listing_view: '#c74a0f',
    call_click: '#3f7a2e',
    directions_click: '#f5a623',
    review_click: '#8f3406',
    search: '#4a413b',
  };
  var TREND_SERIES = [
    { key: 'pageviews', label: 'Pageviews', color: '#f26a21' },
    { key: 'listing_views', label: 'Listing views', color: '#c74a0f' },
    { key: 'lead_actions', label: 'Lead actions', color: '#3f7a2e' },
    { key: 'searches', label: 'Searches', color: '#4a413b' },
  ];

  function fmt(n) {
    return (n || 0).toLocaleString('en-US');
  }

  function labelize(eventType) {
    return String(eventType || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /* --------------------------------------------------------- stat cards */

  function renderStats(row) {
    var stats = row || {};
    setText('stat-sessions', fmt(stats.sessions));
    setText('stat-visitors', fmt(stats.visitors));
    setText('stat-lead-actions', fmt(stats.lead_actions));
    setText('stat-searches', fmt(stats.searches));
    setText('stat-impressions', fmt(stats.impressions));
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /* ------------------------------------------------------- action chart */

  function renderActionChart(rows) {
    var container = document.getElementById('dash-action-chart');
    if (!container) return;
    if (!rows || !rows.length) {
      container.innerHTML = '<p class="dash-chart-empty">No activity in this range yet.</p>';
      return;
    }
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.total) || 0; }));
    container.innerHTML = rows
      .map(function (r) {
        var value = Number(r.total) || 0;
        var pct = max ? Math.max((value / max) * 100, 2) : 0;
        var color = ACTION_COLORS[r.event_type] || '#f26a21';
        return (
          '<div class="dash-bar-row">' +
          '<span class="dash-bar-label">' + escapeHtml(labelize(r.event_type)) + '</span>' +
          '<span class="dash-bar-track"><span class="dash-bar-fill" style="width:' + pct + '%;background:' + color + '"></span></span>' +
          '<span class="dash-bar-value">' + fmt(value) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  /* -------------------------------------------------------- trend chart */

  function renderTrendChart(rows) {
    var container = document.getElementById('dash-trend-chart');
    var legendEl = document.getElementById('dash-trend-legend');
    if (!container) return;
    if (!rows || !rows.length) {
      container.innerHTML = '<p class="dash-chart-empty">No activity in this range yet.</p>';
      if (legendEl) legendEl.innerHTML = '';
      return;
    }

    var width = 640;
    var height = 220;
    var padding = { top: 10, right: 10, bottom: 24, left: 10 };
    var plotW = width - padding.left - padding.right;
    var plotH = height - padding.top - padding.bottom;

    var maxY = 1;
    TREND_SERIES.forEach(function (series) {
      rows.forEach(function (row) {
        maxY = Math.max(maxY, Number(row[series.key]) || 0);
      });
    });

    function xFor(i) {
      return padding.left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
    }
    function yFor(v) {
      return padding.top + plotH - (v / maxY) * plotH;
    }

    var paths = TREND_SERIES.map(function (series) {
      var points = rows
        .map(function (row, i) {
          return xFor(i).toFixed(1) + ',' + yFor(Number(row[series.key]) || 0).toFixed(1);
        })
        .join(' ');
      return '<polyline points="' + points + '" fill="none" stroke="' + series.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />';
    }).join('');

    var firstLabel = rows[0] ? formatDay(rows[0].day) : '';
    var lastLabel = rows[rows.length - 1] ? formatDay(rows[rows.length - 1].day) : '';

    container.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="Daily trend chart" style="width:100%;height:220px">' +
      '<line x1="' + padding.left + '" y1="' + (padding.top + plotH) + '" x2="' + (width - padding.right) + '" y2="' + (padding.top + plotH) + '" stroke="#efe1d5" stroke-width="1" />' +
      paths +
      '</svg>' +
      '<div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--muted);margin-top:0.25rem">' +
      '<span>' + escapeHtml(firstLabel) + '</span><span>' + escapeHtml(lastLabel) + '</span>' +
      '</div>';

    if (legendEl) {
      legendEl.innerHTML = TREND_SERIES.map(function (series) {
        return (
          '<span class="dash-legend-item"><span class="dash-legend-swatch" style="background:' + series.color + '"></span>' +
          escapeHtml(series.label) + '</span>'
        );
      }).join('');
    }
  }

  function formatDay(dayStr) {
    if (!dayStr) return '';
    var d = new Date(dayStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  /* --------------------------------------------------- business table */

  function renderBusinessTable(rows) {
    var body = document.getElementById('dash-business-table-body');
    if (!body) return;
    if (!rows || !rows.length) {
      body.innerHTML = '<tr><td colspan="8">No listing activity in this range yet.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(function (r) {
        var leadActions = (Number(r.directions_clicks) || 0) + (Number(r.call_clicks) || 0) + (Number(r.review_clicks) || 0);
        return (
          '<tr>' +
          '<td>' + escapeHtml(r.listing_name || r.listing_slug || '—') + '</td>' +
          '<td>' + escapeHtml(r.city || '—') + '</td>' +
          '<td>' + fmt(r.directions_clicks) + '</td>' +
          '<td>' + fmt(r.call_clicks) + '</td>' +
          '<td>' + fmt(r.review_clicks) + '</td>' +
          '<td>' + fmt(leadActions) + '</td>' +
          '<td>' + fmt(r.views) + '</td>' +
          '<td>' + fmt(r.total) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------- load */

  function loadAll(days) {
    currentRange = days;
    client.rpc('pumpkinpatchesnearme_dashboard_stats', { days: days }).then(function (res) {
      if (!res.error && res.data && res.data[0]) renderStats(res.data[0]);
    });
    client.rpc('pumpkinpatchesnearme_dashboard_daily', { days: days }).then(function (res) {
      if (!res.error) renderTrendChart(res.data);
    });
    client.rpc('pumpkinpatchesnearme_dashboard_by_action', { days: days }).then(function (res) {
      if (!res.error) renderActionChart(res.data);
    });
    client.rpc('pumpkinpatchesnearme_dashboard_by_business', { days: days }).then(function (res) {
      if (!res.error) renderBusinessTable(res.data);
    });
  }

  var rangeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-range]'));
  rangeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      rangeButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      btn.setAttribute('aria-pressed', 'true');
      loadAll(Number(btn.getAttribute('data-range')));
    });
  });

  /* --------------------------------------------------------- live feed */

  var feedEl = document.getElementById('dash-live-feed');
  var counterEl = document.getElementById('dash-live-counter');
  var MAX_FEED_ITEMS = 25;

  function handleLiveInsert(payload) {
    var row = payload.new || {};
    liveCount += 1;
    if (counterEl) counterEl.textContent = String(liveCount);

    if (!feedEl) return;
    var empty = feedEl.querySelector('.dash-live-empty');
    if (empty) empty.remove();

    var item = document.createElement('li');
    var metaText = row.listing_name || row.path || '';
    var time = new Date(row.created_at || Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    item.innerHTML =
      '<span><span class="dash-live-type">' + escapeHtml(labelize(row.event_type)) + '</span>' +
      (metaText ? ' <span class="dash-live-meta">— ' + escapeHtml(metaText) + '</span>' : '') +
      '</span><span class="dash-live-time">' + escapeHtml(time) + '</span>';
    feedEl.insertBefore(item, feedEl.firstChild);

    while (feedEl.children.length > MAX_FEED_ITEMS) {
      feedEl.removeChild(feedEl.lastChild);
    }
  }

  /* --------------------------------------------------------------- go */

  // Stat cards, charts and the business table are the core of this page —
  // they must render even if Realtime is unavailable (not enabled on the
  // project, blocked network, a client API mismatch). The live panel is a
  // bonus layered on top, isolated in its own try/catch so a failure there
  // can never take down the rest of the dashboard.
  appEl.hidden = false;
  loadAll(currentRange);

  try {
    client
      .channel('dashboard-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, handleLiveInsert)
      .subscribe();
  } catch (e) {
    if (feedEl) feedEl.innerHTML = '<li class="dash-live-empty">Live updates unavailable right now.</li>';
  }
})();
