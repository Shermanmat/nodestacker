(function(){
  'use strict';

  // On localhost, try prod first so dev mirrors prod data. Fall back to
  // local if prod fails (e.g. endpoint not yet deployed).
  var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function fetchJson(path){
    function tryFetch(url){
      return fetch(url, { cache: 'no-store' }).then(function(r){
        var ct = r.headers.get('content-type') || '';
        if(!r.ok || ct.indexOf('json') < 0) throw new Error('not-json');
        return r.json();
      });
    }
    if(isLocal){
      return tryFetch('https://matcap.vc' + path).catch(function(){
        return tryFetch(path); // local fallback
      });
    }
    return tryFetch(path);
  }

  // Reveal-on-scroll
  var revealIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in'); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(function(el){ revealIO.observe(el); });

  // Live firms feed — last 30 days, public endpoint
  function hydrateFirms(){
    var grid = document.querySelector('[data-firm-grid]');
    var countEl = document.querySelector('[data-firm-count]');
    var emptyEl = document.querySelector('[data-firm-empty]');
    if(!grid && !countEl) return;

    fetchJson('/api/public/intros/recent-firms')
      .then(function(d){
        if(countEl) countEl.textContent = d.count;
        if(grid){
          if(d.count === 0){
            grid.style.display = 'none';
            if(emptyEl) emptyEl.style.display = 'block';
            return;
          }
          grid.innerHTML = d.firms.map(function(f){
            return '<div class="firm-tile">' + escapeHtml(f) + '</div>';
          }).join('');
        }
      })
      .catch(function(){
        if(grid) grid.style.display = 'none';
        if(emptyEl) emptyEl.style.display = 'block';
      });
  }

  // Live portfolio — pulls from /api/public/portfolio
  function hydratePortfolio(){
    var grid = document.querySelector('[data-portfolio-grid]');
    var emptyEl = document.querySelector('[data-portfolio-empty]');
    if(!grid) return;

    fetchJson('/api/public/portfolio')
      .then(function(d){
        if(!d.items || d.items.length === 0){
          grid.style.display = 'none';
          if(emptyEl) emptyEl.style.display = 'block';
          return;
        }

        grid.innerHTML = d.items.map(function(item){
          var oneLiner = item.one_liner ? '<div class="p-line">' + escapeHtml(item.one_liner) + '</div>' : '';
          var stealthBadge = item.is_stealth ? '<div class="p-stealth">Stealth</div>' : '';
          var readLink = item.case_study_slug
            ? '<div class="p-read">Read →</div>'
            : '';
          var inner =
            stealthBadge +
            '<div class="p-name">' + escapeHtml(item.name) + '</div>' +
            oneLiner +
            readLink;
          return item.case_study_slug
            ? '<a class="portfolio-card linkable" href="/case-studies/' + encodeURIComponent(item.case_study_slug) + '">' + inner + '</a>'
            : '<div class="portfolio-card">' + inner + '</div>';
        }).join('');
      })
      .catch(function(){
        grid.style.display = 'none';
        if(emptyEl) emptyEl.style.display = 'block';
      });
  }

  hydrateFirms();
  hydratePortfolio();
})();
