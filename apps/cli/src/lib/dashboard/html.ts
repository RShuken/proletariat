/**
 * Dashboard HTML Template
 *
 * Returns a complete self-contained HTML page for the real-time web dashboard.
 * Uses WebSocket for live updates every 3 seconds.
 * Features: agent status cards, token usage, ticket board, tmux output peek.
 * Mobile responsive via CSS media queries.
 *
 * Styled to match the proletariat marketing site — Switzer font,
 * JetBrains Mono, pink-600 accents, clean white cards, Tailwind CDN.
 *
 * Security: All dynamic content is escaped via the esc() helper which uses
 * textContent assignment on a detached DOM element to prevent XSS.
 */

export function getDashboardHTML(port: number): string {
  return `<!DOCTYPE html>
<html lang="en" class="antialiased">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>prlt dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://api.fontshare.com/css?f[]=switzer@400,500,600,700&display=swap">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Switzer', 'system-ui', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            pink: {
              600: '#D15052',
            },
            gray: {
              750: '#2a2a2e',
              850: '#1e1e22',
              900: '#181818',
              950: '#111113',
            },
          },
        },
      },
    }
  </script>
  <style>
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .animate-pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }

    .tmux-peek {
      font-size: 11px;
      line-height: 1.4;
      white-space: pre;
      overflow-x: auto;
      tab-size: 4;
    }

    @media (max-width: 640px) {
      .kanban-scroll { flex-direction: column; }
      .kanban-scroll > div { min-width: 100% !important; max-width: 100% !important; }
      .agent-grid { grid-template-columns: 1fr !important; }
      .peek-grid { grid-template-columns: 1fr !important; }
      .session-table { display: block; overflow-x: auto; }
      .pr-item { flex-direction: column; align-items: flex-start !important; gap: 0.5rem !important; }
    }
  </style>
</head>
<body class="bg-white text-gray-950 font-sans min-h-screen">

  <header class="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
      <div class="flex items-center gap-3 sm:gap-4">
        <h1 class="text-base sm:text-lg font-semibold tracking-tight text-gray-950">
          <span class="text-pink-600">prlt</span> dashboard
        </h1>
        <span id="project-name" class="font-mono text-[10px] sm:text-xs uppercase tracking-widest text-gray-500 bg-gray-100 px-2 sm:px-3 py-1 rounded-full">loading...</span>
      </div>
      <div class="flex items-center gap-2 sm:gap-3 text-xs text-gray-400">
        <span id="status-dot" class="w-2 h-2 rounded-full bg-gray-300"></span>
        <span id="status-text">Connecting...</span>
        <span id="last-updated" class="hidden sm:inline text-gray-400"></span>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8 sm:space-y-10">

    <!-- Agent Status Cards -->
    <section id="agents-section">
      <div class="flex items-center gap-3 mb-4">
        <h2 class="font-mono text-xs uppercase tracking-widest text-gray-500">Agents</h2>
        <span id="agents-count" class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div id="agents-grid" class="agent-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"></div>
    </section>

    <!-- Ticket Board -->
    <section id="board-section">
      <div class="flex items-center gap-3 mb-4">
        <h2 class="font-mono text-xs uppercase tracking-widest text-gray-500">Board</h2>
        <span id="board-count" class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div id="kanban" class="kanban-scroll flex gap-3 overflow-x-auto pb-2"></div>
    </section>

    <!-- Tmux Output Peek -->
    <section id="peek-section" class="hidden">
      <div class="flex items-center gap-3 mb-4">
        <h2 class="font-mono text-xs uppercase tracking-widest text-gray-500">Live Output</h2>
        <span id="peek-count" class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div id="peek-grid" class="peek-grid grid grid-cols-1 lg:grid-cols-2 gap-3"></div>
    </section>

    <!-- Sessions -->
    <section id="sessions-section">
      <div class="flex items-center gap-3 mb-4">
        <h2 class="font-mono text-xs uppercase tracking-widest text-gray-500">Sessions</h2>
        <span id="sessions-count" class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div class="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 overflow-hidden session-table">
        <table class="w-full">
          <thead>
            <tr class="border-b border-gray-100">
              <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-widest text-gray-400 font-medium">Session</th>
              <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-widest text-gray-400 font-medium">Ticket</th>
              <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-widest text-gray-400 font-medium">Agent</th>
              <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Environment</th>
              <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-widest text-gray-400 font-medium">Status</th>
            </tr>
          </thead>
          <tbody id="sessions-body"></tbody>
        </table>
      </div>
    </section>

    <!-- PRs -->
    <section id="prs-section">
      <div class="flex items-center gap-3 mb-4">
        <h2 class="font-mono text-xs uppercase tracking-widest text-gray-500">Pull Requests</h2>
        <span id="prs-count" class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div id="pr-list" class="space-y-2"></div>
    </section>

  </main>

  <script>
    // All dynamic content is escaped via this helper to prevent XSS.
    // It uses textContent on a detached element, which is the standard
    // safe approach for HTML entity encoding.
    var _escDiv = document.createElement('div');
    function esc(str) {
      if (!str) return '';
      _escDiv.textContent = str;
      return _escDiv.innerHTML;
    }

    function priorityClasses(p) {
      switch (p) {
        case 'P0': return 'text-red-600 ring-red-200 bg-red-50';
        case 'P1': return 'text-orange-600 ring-orange-200 bg-orange-50';
        case 'P2': return 'text-yellow-600 ring-yellow-200 bg-yellow-50';
        case 'P3': return 'text-gray-500 ring-gray-200 bg-gray-50';
        default: return 'text-gray-500 ring-gray-200 bg-gray-50';
      }
    }

    function statusConfig(status) {
      switch (status) {
        case 'working':     return { dot: 'bg-green-400 animate-pulse-dot', border: 'border-l-green-400', label: 'Working', labelCls: 'text-green-600 bg-green-50 ring-green-200' };
        case 'idle':        return { dot: 'bg-gray-300', border: 'border-l-gray-300', label: 'Idle', labelCls: 'text-gray-500 bg-gray-50 ring-gray-200' };
        case 'needs-input': return { dot: 'bg-yellow-400 animate-pulse-dot', border: 'border-l-yellow-400', label: 'Needs Input', labelCls: 'text-yellow-600 bg-yellow-50 ring-yellow-200' };
        case 'error':       return { dot: 'bg-red-400', border: 'border-l-red-400', label: 'Error', labelCls: 'text-red-600 bg-red-50 ring-red-200' };
        default:            return { dot: 'bg-gray-300', border: 'border-l-gray-300', label: status, labelCls: 'text-gray-500 bg-gray-50 ring-gray-200' };
      }
    }

    function formatElapsed(seconds) {
      if (!seconds && seconds !== 0) return '';
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      return h + 'h ' + m + 'm';
    }

    function formatTokens(count) {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return String(count);
    }

    function formatCost(usd) {
      if (usd >= 1) return '$' + usd.toFixed(2);
      if (usd >= 0.01) return '$' + usd.toFixed(3);
      return '$' + usd.toFixed(4);
    }

    // =========================================================================
    // Render: Agent Status Cards
    // =========================================================================

    function renderAgents(agents) {
      var grid = document.getElementById('agents-grid');
      document.getElementById('agents-count').textContent = agents.length;

      if (agents.length === 0) {
        grid.textContent = '';
        var p = document.createElement('p');
        p.className = 'text-sm text-gray-400 py-8 text-center col-span-full';
        p.textContent = 'No agents found';
        grid.appendChild(p);
        return;
      }

      // Build cards using DOM methods for safety, with esc() for any HTML strings
      var html = agents.map(function(a) {
        var sc = statusConfig(a.derivedStatus || 'idle');

        var tokenHtml = '';
        if (a.tokenUsage) {
          var tu = a.tokenUsage;
          tokenHtml = '<div class="mt-3 pt-3 border-t border-gray-100">' +
            '<div class="flex items-center justify-between text-[10px] font-mono text-gray-400">' +
              '<span>Tokens</span>' +
              (tu.estimatedCostUsd > 0 ? '<span class="text-pink-600 font-medium">' + esc(formatCost(tu.estimatedCostUsd)) + '</span>' : '') +
            '</div>' +
            '<div class="flex gap-3 mt-1 text-[10px] font-mono">' +
              '<span class="text-gray-500">in: <span class="text-gray-950 font-medium">' + esc(formatTokens(tu.inputTokens)) + '</span></span>' +
              '<span class="text-gray-500">out: <span class="text-gray-950 font-medium">' + esc(formatTokens(tu.outputTokens)) + '</span></span>' +
              (tu.cacheReadTokens > 0 ? '<span class="text-gray-500">cache: <span class="text-gray-950 font-medium">' + esc(formatTokens(tu.cacheReadTokens)) + '</span></span>' : '') +
            '</div>' +
            (tu.model ? '<div class="text-[9px] font-mono text-gray-400 mt-1 truncate">' + esc(tu.model) + '</div>' : '') +
          '</div>';
        }

        var ticketBadges = '';
        var ticketList = a.assignedTickets || [];
        if (ticketList.length > 0) {
          ticketBadges = '<div class="flex gap-1.5 flex-wrap mt-2">' +
            ticketList.map(function(t) {
              var isActive = a.currentTicket === t;
              var cls = isActive ? 'text-pink-600 bg-pink-50 ring-pink-600/20' : 'text-gray-500 bg-gray-50 ring-gray-200';
              return '<span class="font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-lg ring-1 ' + cls + '">' + esc(t) + '</span>';
            }).join('') +
          '</div>';
        }

        var elapsedHtml = '';
        if (a.elapsedSeconds !== undefined && a.elapsedSeconds !== null && a.derivedStatus === 'working') {
          elapsedHtml = '<span class="font-mono text-[10px] text-gray-400">' + esc(formatElapsed(a.elapsedSeconds)) + '</span>';
        }

        return '<div class="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-4 transition-all hover:ring-pink-600/30 border-l-[3px] ' + sc.border + '">' +
          '<div class="flex items-center justify-between">' +
            '<div class="flex items-center gap-2">' +
              '<span class="w-2 h-2 rounded-full flex-shrink-0 ' + sc.dot + '"></span>' +
              '<span class="text-sm font-semibold text-gray-950">' + esc(a.name) + '</span>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              elapsedHtml +
              '<span class="font-mono text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 ' + sc.labelCls + '">' + esc(sc.label) + '</span>' +
            '</div>' +
          '</div>' +
          (a.branch ? '<div class="font-mono text-xs text-gray-400 mt-1.5 truncate">' + esc(a.branch) + '</div>' : '') +
          ticketBadges +
          tokenHtml +
        '</div>';
      }).join('');

      grid.innerHTML = html; // All values escaped via esc()
    }

    // =========================================================================
    // Render: Ticket Board
    // =========================================================================

    function renderBoard(board) {
      var kanban = document.getElementById('kanban');
      var cols = board.columns || [];
      var totalTickets = 0;
      cols.forEach(function(c) { totalTickets += (c.tickets || []).length; });
      document.getElementById('board-count').textContent = totalTickets;

      if (cols.length === 0) {
        kanban.textContent = '';
        var p = document.createElement('p');
        p.className = 'text-sm text-gray-400 py-8 text-center w-full';
        p.textContent = 'No board data';
        kanban.appendChild(p);
        return;
      }

      kanban.innerHTML = cols.map(function(col) { // All values escaped via esc()
        var tickets = col.tickets || [];
        return '<div class="min-w-[240px] max-w-[300px] flex-1 bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 flex flex-col max-h-[500px]">' +
          '<div class="px-4 py-3 border-b border-gray-100 flex justify-between items-center flex-shrink-0">' +
            '<span class="text-sm font-medium text-gray-950">' + esc(col.name) + '</span>' +
            '<span class="font-mono text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">' + tickets.length + '</span>' +
          '</div>' +
          '<div class="p-2 overflow-y-auto flex-1 space-y-1.5">' +
            (tickets.length === 0 ? '' : tickets.map(function(t) {
              var meta = '';
              if (t.priority) meta += '<span class="inline-flex text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-lg ring-1 ' + priorityClasses(t.priority) + '">' + esc(t.priority) + '</span>';
              if (t.category) meta += '<span class="inline-flex text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-lg ring-1 ring-purple-200 text-purple-600 bg-purple-50">' + esc(t.category) + '</span>';
              if (t.assignee) meta += '<span class="inline-flex text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-lg ring-1 ring-pink-600/20 text-pink-600 bg-pink-50">' + esc(t.assignee) + '</span>';
              (t.labels || []).forEach(function(l) { meta += '<span class="inline-flex text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-lg ring-1 ring-gray-200 text-gray-500 bg-gray-50">' + esc(l) + '</span>'; });
              return '<div class="bg-gray-50 rounded-xl p-3 transition-all hover:ring-1 hover:ring-pink-600/30 cursor-default">' +
                '<div class="font-mono text-[11px] font-semibold text-pink-600">' + esc(t.id) + '</div>' +
                '<div class="text-sm text-gray-950 mt-1 leading-snug">' + esc(t.title) + '</div>' +
                (meta ? '<div class="flex gap-1.5 mt-2 flex-wrap">' + meta + '</div>' : '') +
              '</div>';
            }).join('')) +
          '</div>' +
        '</div>';
      }).join('');
    }

    // =========================================================================
    // Render: Tmux Output Peek
    // =========================================================================

    function fetchPeek(sessionId) {
      return fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/peek?lines=50')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var pre = document.getElementById('peek-pre-' + sessionId);
          if (pre && data.lines) {
            pre.textContent = data.lines.join('\\n');
          }
        })
        .catch(function() {});
    }

    function sendToSession(sessionId) {
      var input = document.getElementById('send-input-' + sessionId);
      if (!input || !input.value.trim()) return;
      var text = input.value;
      input.value = '';
      input.disabled = true;
      fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      }).then(function() {
        input.disabled = false;
        input.focus();
        setTimeout(function() { fetchPeek(sessionId); }, 500);
      }).catch(function() {
        input.disabled = false;
      });
    }

    function renderPeeks(peeks) {
      var section = document.getElementById('peek-section');
      var grid = document.getElementById('peek-grid');
      document.getElementById('peek-count').textContent = peeks.length;

      if (peeks.length === 0) {
        section.classList.add('hidden');
        return;
      }

      section.classList.remove('hidden');

      // All values escaped via esc() — innerHTML is safe here because every
      // dynamic value goes through esc() which uses textContent assignment
      grid.innerHTML = peeks.map(function(peek) {
        var content = (peek.lines || []).map(function(l) { return esc(l); }).join('\\n');
        var sid = esc(peek.sessionId);
        return '<div class="bg-gray-950 rounded-2xl shadow-sm ring-1 ring-gray-800 overflow-hidden">' +
          '<div class="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">' +
            '<div class="flex items-center gap-2">' +
              '<div class="flex gap-1">' +
                '<span class="w-2.5 h-2.5 rounded-full bg-red-400/80"></span>' +
                '<span class="w-2.5 h-2.5 rounded-full bg-yellow-400/80"></span>' +
                '<span class="w-2.5 h-2.5 rounded-full bg-green-400/80"></span>' +
              '</div>' +
              '<span class="font-mono text-xs text-gray-400 ml-2">' + esc(peek.agentName) + '</span>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              '<span class="font-mono text-[10px] text-gray-600">' + sid + '</span>' +
              '<button onclick="fetchPeek(\\''+sid.replace(/'/g,"\\\\'")+'\\')" class="text-gray-600 hover:text-green-400 transition-colors" title="Refresh">' +
                '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="p-3 max-h-[300px] overflow-y-auto">' +
            '<pre id="peek-pre-' + sid + '" class="tmux-peek font-mono text-green-400/90">' + content + '</pre>' +
          '</div>' +
          '<div class="px-3 pb-3 pt-1 border-t border-gray-800/50">' +
            '<form onsubmit="event.preventDefault();sendToSession(\\''+sid.replace(/'/g,"\\\\'")+'\\')" class="flex gap-2">' +
              '<input id="send-input-' + sid + '" type="text" placeholder="Send message..." ' +
                'class="flex-1 bg-gray-900 text-green-400 font-mono text-xs px-3 py-1.5 rounded-lg border border-gray-800 focus:border-green-400/50 focus:outline-none placeholder-gray-700" />' +
              '<button type="submit" class="px-3 py-1.5 bg-green-400/10 text-green-400 font-mono text-xs rounded-lg hover:bg-green-400/20 transition-colors">Send</button>' +
            '</form>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // =========================================================================
    // Render: Sessions Table
    // =========================================================================

    function renderSessions(sessions) {
      var body = document.getElementById('sessions-body');
      document.getElementById('sessions-count').textContent = sessions.length;

      if (sessions.length === 0) {
        body.textContent = '';
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'text-sm text-gray-400 text-center py-8';
        td.textContent = 'No active sessions';
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }

      body.innerHTML = sessions.map(function(s) { // All values escaped via esc()
        var envLabel = s.environment === 'container' ? 'container' : 'host';
        var statusCls = 'text-gray-500 bg-gray-50 ring-gray-200';
        if (s.status === 'running') statusCls = 'text-green-600 bg-green-50 ring-green-200';
        else if (s.status === 'starting') statusCls = 'text-yellow-600 bg-yellow-50 ring-yellow-200';
        else if (s.status === 'orphan') statusCls = 'text-orange-600 bg-orange-50 ring-orange-200';
        return '<tr class="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">' +
          '<td class="px-4 py-3 font-mono text-xs text-gray-400">' + esc(s.sessionId) + '</td>' +
          '<td class="px-4 py-3 font-mono text-xs font-medium text-pink-600">' + esc(s.ticketId) + '</td>' +
          '<td class="px-4 py-3 text-sm text-gray-950">' + esc(s.agentName) + '</td>' +
          '<td class="px-4 py-3 hidden sm:table-cell"><span class="font-mono text-[10px] uppercase tracking-widest text-gray-400">' + esc(envLabel) + '</span></td>' +
          '<td class="px-4 py-3"><span class="font-mono text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 ' + statusCls + '">' + esc(s.status) + '</span></td>' +
        '</tr>';
      }).join('');
    }

    // =========================================================================
    // Render: Pull Requests
    // =========================================================================

    function renderPRs(prs) {
      var list = document.getElementById('pr-list');
      document.getElementById('prs-count').textContent = prs.length;

      if (prs.length === 0) {
        list.textContent = '';
        var p = document.createElement('p');
        p.className = 'text-sm text-gray-400 py-8 text-center';
        p.textContent = 'No open pull requests';
        list.appendChild(p);
        return;
      }

      list.innerHTML = prs.map(function(pr) { // All values escaped via esc()
        var ciClass = pr.ciStatus || 'unknown';
        var ciCls = 'text-gray-500 bg-gray-50 ring-gray-200';
        var ciLabel = 'unknown';
        if (ciClass === 'success') { ciCls = 'text-green-600 bg-green-50 ring-green-200'; ciLabel = 'passed'; }
        else if (ciClass === 'failure') { ciCls = 'text-red-600 bg-red-50 ring-red-200'; ciLabel = 'failed'; }
        else if (ciClass === 'pending') { ciCls = 'text-yellow-600 bg-yellow-50 ring-yellow-200'; ciLabel = 'running'; }
        return '<div class="pr-item bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 px-4 sm:px-5 py-3 sm:py-3.5 flex items-center gap-3 sm:gap-4 transition-all hover:ring-pink-600/30">' +
          '<a href="' + esc(pr.url) + '" target="_blank" rel="noopener noreferrer" class="font-mono text-sm font-semibold text-pink-600 hover:underline min-w-[50px]">#' + pr.number + '</a>' +
          '<span class="text-sm text-gray-950 flex-1 min-w-0 truncate">' + esc(pr.title) + '</span>' +
          (pr.isDraft ? '<span class="font-mono text-[10px] uppercase tracking-widest text-gray-400 ring-1 ring-gray-200 px-2 py-0.5 rounded-full flex-shrink-0">draft</span>' : '') +
          '<span class="font-mono text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-lg max-w-[220px] truncate hidden sm:inline-flex flex-shrink-0">' + esc(pr.headBranch) + '</span>' +
          '<span class="font-mono text-[10px] font-medium px-2 py-0.5 rounded-full ring-1 whitespace-nowrap flex-shrink-0 ' + ciCls + '">' + esc(ciLabel) + '</span>' +
        '</div>';
      }).join('');
    }

    // =========================================================================
    // Render All
    // =========================================================================

    function renderAll(data) {
      document.getElementById('project-name').textContent = data.projectName || data.projectId;
      var ts = new Date(data.timestamp);
      document.getElementById('last-updated').textContent = ts.toLocaleTimeString();
      renderAgents(data.agents || []);
      renderBoard(data.board || { columns: [] });
      renderPeeks(data.tmuxPeeks || []);
      renderSessions(data.sessions || []);
      renderPRs(data.prs || []);
    }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    var dot = document.getElementById('status-dot');
    var statusText = document.getElementById('status-text');
    var reconnectDelay = 1000;

    function connectWebSocket() {
      var wsUrl = 'ws://localhost:${port}';
      var ws = new WebSocket(wsUrl);

      ws.onopen = function() {
        dot.className = 'w-2 h-2 rounded-full bg-green-400';
        statusText.textContent = 'Live';
        reconnectDelay = 1000;
      };

      ws.onmessage = function(event) {
        try {
          var data = JSON.parse(event.data);
          renderAll(data);
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };

      ws.onclose = function() {
        dot.className = 'w-2 h-2 rounded-full bg-yellow-400';
        statusText.textContent = 'Reconnecting...';
        setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      };

      ws.onerror = function() {
        dot.className = 'w-2 h-2 rounded-full bg-red-400';
        statusText.textContent = 'Error';
        ws.close();
      };
    }

    // Initial fetch via HTTP for fast first paint, then WebSocket for live updates
    fetch('/api/data')
      .then(function(r) { return r.json(); })
      .then(function(data) { renderAll(data); })
      .catch(function(err) { console.error('Initial fetch failed:', err); });

    connectWebSocket();
  </script>
</body>
</html>`
}
