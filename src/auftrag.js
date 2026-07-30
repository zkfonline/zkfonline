/* ZKFonline client area: magic-link gate, 4-step intake form, image handling.
   Drafts live in localStorage so a long form survives a closed tab; the access
   token lives in sessionStorage so it does not outlive the browser session. */
(function () {
    'use strict';

    var TOKEN_KEY = 'zkf-auftrag-token';
    var DRAFT_KEY = 'zkf-auftrag-draft';
    var MAX_BILDER = 10;
    var MAX_KANTE = 2000;      // px on the long edge after downscaling
    var ZIEL_BYTES = 1400000;  // per image; we step quality down to get under this

    var FELDER = [
        'firma', 'inhaber', 'strasse', 'plz', 'ort', 'telefon', 'fax', 'email',
        'wunschdomain', 'bestehendeDomain', 'oeffnungszeiten', 'leistungen',
        'marken', 'ueberUns', 'mitarbeiter', 'gruendung', 'notdienst', 'zusatzWuensche'
    ];
    var LABELS = {
        firma: 'Firma', inhaber: 'Inhaber / Geschäftsführer', strasse: 'Straße',
        plz: 'PLZ', ort: 'Ort', telefon: 'Telefon', fax: 'Fax', email: 'E-Mail',
        wunschdomain: 'Wunsch-Domain', bestehendeDomain: 'Bestehende Domain',
        oeffnungszeiten: 'Öffnungszeiten', leistungen: 'Leistungen',
        marken: 'Marken / Partner', ueberUns: 'Über den Betrieb',
        mitarbeiter: 'Mitarbeiter', gruendung: 'Gegründet',
        notdienst: 'Notdienst', zusatzWuensche: 'Zusätzliche Wünsche'
    };
    var PFLICHT = ['firma', 'inhaber', 'ort', 'telefon', 'leistungen'];
    // Which step each required field lives on, so validation can jump there.
    var SCHRITT_VON = { firma: 0, inhaber: 0, ort: 0, telefon: 0, leistungen: 1 };

    var $ = function (id) { return document.getElementById(id); };
    var gate = $('gate'), auftrag = $('auftrag');
    var bilder = [];
    var schritt = 0;
    var token = null;

    // ---------------------------------------------------------------- gate
    function zeigeGateFehler(text) {
        var box = $('gate-status');
        box.textContent = text;
        box.hidden = false;
    }

    $('gate-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        $('gate-status').hidden = true;
        var email = $('gate-email').value.trim();
        if (!/^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(email)) {
            zeigeGateFehler('Bitte geben Sie eine gültige E-Mail-Adresse ein.');
            return;
        }
        $('gate-btn').disabled = true;
        $('gate-label').textContent = 'Wird gesendet …';
        try {
            var res = await fetch('/api/zugang', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: email })
            });
            if (!res.ok) throw new Error('http ' + res.status);
            $('gate-form').hidden = true;
            $('gate-sent').hidden = false;
        } catch (err) {
            zeigeGateFehler('Der Zugangslink konnte nicht angefordert werden. Bitte versuchen Sie es später erneut oder schreiben Sie an support@innomega.de.');
        } finally {
            $('gate-btn').disabled = false;
            $('gate-label').textContent = 'Zugangslink anfordern';
        }
    });

    async function tokenPruefen(t) {
        try {
            var res = await fetch('/api/zugang?pruefen=1', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ token: t })
            });
            if (!res.ok) return null;
            var d = await res.json();
            return d.ok ? d.email : null;
        } catch (err) { return null; }
    }

    // ------------------------------------------------------------ entwurf
    function entwurfSpeichern() {
        var daten = {};
        FELDER.forEach(function (f) { var el = $(f); if (el) daten[f] = el.value; });
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(daten)); } catch (e) {}
    }

    function entwurfLaden() {
        try {
            var daten = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
            FELDER.forEach(function (f) { var el = $(f); if (el && daten[f]) el.value = daten[f]; });
        } catch (e) {}
    }

    // -------------------------------------------------------------- steps
    function zeigeSchritt(n) {
        schritt = Math.max(0, Math.min(3, n));
        Array.prototype.forEach.call(document.querySelectorAll('.step-panel'), function (p) {
            p.hidden = +p.dataset.panel !== schritt;
        });
        Array.prototype.forEach.call(document.querySelectorAll('.step-pill'), function (p) {
            p.setAttribute('aria-current', +p.dataset.step === schritt ? 'true' : 'false');
        });
        $('prev-btn').disabled = schritt === 0;
        $('next-btn').hidden = schritt === 3;
        if (schritt === 3) pruefungAufbauen();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.step-pill'), function (p) {
        p.addEventListener('click', function () { zeigeSchritt(+p.dataset.step); });
    });
    $('next-btn').addEventListener('click', function () { zeigeSchritt(schritt + 1); });
    $('prev-btn').addEventListener('click', function () { zeigeSchritt(schritt - 1); });

    function pruefungAufbauen() {
        var dl = $('review');
        dl.replaceChildren();
        FELDER.forEach(function (f) {
            var el = $(f);
            if (!el || !el.value.trim()) return;
            var dt = document.createElement('dt');
            dt.textContent = LABELS[f] || f;
            var dd = document.createElement('dd');
            dd.textContent = el.value.trim();
            dl.appendChild(dt); dl.appendChild(dd);
        });
        var dt2 = document.createElement('dt');
        dt2.textContent = 'Bilder';
        var dd2 = document.createElement('dd');
        dd2.textContent = bilder.length ? bilder.length + ' Bild(er) ausgewählt' : 'keine Bilder ausgewählt';
        dl.appendChild(dt2); dl.appendChild(dd2);
    }

    // -------------------------------------------------------------- images
    function bildStatus(text) {
        var box = $('bild-status');
        if (!text) { box.hidden = true; return; }
        box.textContent = text;
        box.hidden = false;
    }

    /** Downscale in the browser: keeps the upload small enough for one mail
        and means the customer never has to resize a phone photo by hand. */
    function verkleinern(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                URL.revokeObjectURL(url);
                var w = img.naturalWidth, h = img.naturalHeight;
                var faktor = Math.min(1, MAX_KANTE / Math.max(w, h));
                var cw = Math.round(w * faktor), ch = Math.round(h * faktor);
                var canvas = document.createElement('canvas');
                canvas.width = cw; canvas.height = ch;
                canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);

                var q = 0.85, data = canvas.toDataURL('image/jpeg', q);
                while (data.length * 0.75 > ZIEL_BYTES && q > 0.4) {
                    q -= 0.12;
                    data = canvas.toDataURL('image/jpeg', q);
                }
                resolve({ name: file.name.replace(/\.[^.]+$/, ''), data: data, bytes: Math.round(data.length * 0.75) });
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('kein bild')); };
            img.src = url;
        });
    }

    function thumbsZeichnen() {
        var box = $('thumbs');
        box.replaceChildren();
        bilder.forEach(function (b, i) {
            var d = document.createElement('div');
            d.className = 'thumb';
            var img = document.createElement('img');
            img.src = b.data; img.alt = b.name;
            var meta = document.createElement('div');
            meta.className = 'thumb-meta';
            meta.textContent = Math.round(b.bytes / 1024) + ' KB';
            var btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'thumb-remove';
            btn.setAttribute('aria-label', 'Bild entfernen');
            btn.textContent = '×';
            btn.addEventListener('click', function () {
                bilder.splice(i, 1); thumbsZeichnen(); bildStatus('');
            });
            d.appendChild(img); d.appendChild(meta); d.appendChild(btn);
            box.appendChild(d);
        });
    }

    async function dateienAufnehmen(files) {
        bildStatus('');
        var liste = Array.prototype.slice.call(files);
        for (var i = 0; i < liste.length; i++) {
            if (bilder.length >= MAX_BILDER) {
                bildStatus('Es sind maximal ' + MAX_BILDER + ' Bilder möglich.');
                break;
            }
            if (!/^image\/(jpeg|png|webp)$/.test(liste[i].type)) {
                bildStatus('„' + liste[i].name + '“ ist kein JPG-, PNG- oder WebP-Bild.');
                continue;
            }
            try {
                bilder.push(await verkleinern(liste[i]));
            } catch (err) {
                bildStatus('„' + liste[i].name + '“ konnte nicht gelesen werden.');
            }
        }
        thumbsZeichnen();
    }

    var dz = $('drop-zone'), fi = $('file-input');
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener('change', function () { dateienAufnehmen(fi.files); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
    });
    dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) dateienAufnehmen(e.dataTransfer.files);
    });

    // -------------------------------------------------------------- submit
    function zeigeFehler(text) {
        var box = $('form-status');
        box.textContent = text;
        box.hidden = false;
    }

    $('auftrag-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        $('form-status').hidden = true;

        PFLICHT.forEach(function (f) { $(f).removeAttribute('aria-invalid'); });
        var fehlend = PFLICHT.filter(function (f) { return !$(f).value.trim(); });
        if (fehlend.length) {
            fehlend.forEach(function (f) { $(f).setAttribute('aria-invalid', 'true'); });
            zeigeSchritt(SCHRITT_VON[fehlend[0]]);
            $(fehlend[0]).focus();
            zeigeFehler('Bitte füllen Sie alle Pflichtfelder aus (fehlt: ' +
                fehlend.map(function (f) { return LABELS[f]; }).join(', ') + ').');
            return;
        }
        if (!$('datenschutz').checked) {
            zeigeFehler('Bitte bestätigen Sie die Verarbeitung Ihrer Angaben.');
            return;
        }

        var nutzlast = { token: token, bilder: bilder, website: $('hp-website').value };
        FELDER.forEach(function (f) { nutzlast[f] = $(f).value; });

        $('submit-btn').disabled = true;
        $('submit-label').textContent = 'Wird übermittelt …';
        try {
            var res = await fetch('/api/auftrag', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(nutzlast)
            });
            var daten = {};
            try { daten = await res.json(); } catch (err) {}

            if (res.ok && daten.ok) {
                try { localStorage.removeItem(DRAFT_KEY); } catch (err) {}
                $('auftrag-form').hidden = true;
                document.querySelector('.steps-bar').hidden = true;
                $('save-note').hidden = true;
                $('done-panel').hidden = false;
                $('done-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            if (res.status === 401) {
                zeigeFehler('Ihr Zugang ist abgelaufen. Bitte fordern Sie einen neuen Zugangslink an.');
                return;
            }
            zeigeFehler(daten.fehler === 'bilder insgesamt zu groß'
                ? 'Die Bilder sind zusammen zu groß. Bitte entfernen Sie einige und versuchen Sie es erneut.'
                : 'Der Auftrag konnte nicht übermittelt werden. Bitte versuchen Sie es erneut oder schreiben Sie an support@innomega.de.');
        } catch (err) {
            zeigeFehler('Die Verbindung ist fehlgeschlagen. Bitte prüfen Sie Ihre Internetverbindung.');
        } finally {
            $('submit-btn').disabled = false;
            $('submit-label').textContent = 'Angaben übermitteln';
        }
    });

    // ---------------------------------------------------------------- boot
    (async function start() {
        var url = new URL(window.location.href);
        var ausUrl = url.searchParams.get('zugang');
        var gespeichert = null;
        try { gespeichert = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}

        var kandidat = ausUrl || gespeichert;
        if (!kandidat) return; // stay on the gate

        var email = await tokenPruefen(kandidat);
        if (!email) {
            try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
            if (ausUrl) zeigeGateFehler('Dieser Zugangslink ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.');
            return;
        }

        token = kandidat;
        try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        // Keep the token out of the address bar / browser history.
        if (ausUrl) window.history.replaceState({}, '', url.pathname);

        gate.hidden = true;
        auftrag.hidden = false;
        $('session-email').textContent = email;
        entwurfLaden();
        if (!$('email').value) $('email').value = email;
        zeigeSchritt(0);

        FELDER.forEach(function (f) {
            var el = $(f);
            if (el) el.addEventListener('input', entwurfSpeichern);
        });
    })();
})();
