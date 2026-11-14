// The panel's one script. Text only: values are written with textContent,
// DOM nodes are built with createElement, never from HTML strings.
(() => {
  // Times: <time datetime="ISO">… UTC</time> → the viewer's local time.
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.getAttribute("datetime"));
    if (!Number.isNaN(d.getTime())) { t.title = t.textContent; t.textContent = fmt.format(d); }
  }

  // Dialogs: [data-dialog=id] opens <dialog id>, [data-close] closes it.
  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-dialog]");
    if (opener) { const dlg = document.getElementById(opener.dataset.dialog); if (dlg && dlg.showModal) { e.preventDefault(); dlg.showModal(); } return; }
    const closer = e.target.closest("[data-close]");
    if (closer) { const dlg = closer.closest("dialog"); if (dlg) dlg.close(); }
  });

  // A second tap on a submit button must not send the form twice.
  document.addEventListener("submit", (e) => {
    for (const b of e.target.querySelectorAll("button[type=submit], button:not([type])")) { if (!e.defaultPrevented) setTimeout(() => { b.disabled = true; }, 0); }
  });


  // Action forms: reason chips, quick values, ban mode, preview + effect line.
  let ladder = null;
  try { const el = document.getElementById("ladder"); if (el) ladder = JSON.parse(el.textContent); } catch { ladder = null; }
  const SEP = " \u2014 ";
  const hoursText = (h) => h + (Number(h) === 1 ? " hour" : " hours");
  const rungText = (r) => {
    if (!r) return "";
    if (r.outcome === "warn") return "a warning message";
    if (r.outcome === "ban") return "banned for " + hoursText(r.hours);
    if (r.outcome === "restricted") return "needs an admin: this form can't send it";
    return r.outcome === "lock" ? "account locked" : "banned until a moderator lifts it";
  };
  const rungOf = (form) => {
    if (!ladder || !form.elements.type) return null;
    const t = ladder.types.find((x) => x.type === form.elements.type.value);
    const lv = Number(form.elements.level && form.elements.level.value);
    return t ? { t, rung: t.rungs[lv - 1] || null, level: lv } : null;
  };
  const refresh = (form) => {
    const kind = form.dataset.kind, name = form.dataset.name || "They";
    const mode = form.elements.mode && form.elements.mode.value;
    for (const box of form.querySelectorAll("[data-mode]")) box.hidden = !!mode && box.dataset.mode !== mode;
    const r = rungOf(form);
    const prev = form.querySelector("[data-preview]");
    if (prev) prev.textContent = r ? (r.level < r.t.min ? r.t.type + " starts at level " + r.t.min : "The player sees: " + rungText(r.rung)) : "";
    let eff = "";
    if (kind === "kick") eff = name + " is kicked now.";
    else if (kind === "unmute") eff = name + " can chat again.";
    else if (kind === "unban") eff = name + "'s ban is lifted.";
    else if (kind === "mute") eff = name + " is muted for " + (form.elements.minutes.value || "?") + " minutes.";
    else if (kind === "warn") eff = name + " gets a warning" + (r && r.rung && r.rung.outcome !== "warn" ? " (this level isn't a warning)" : "") + ".";
    else if (kind === "ban") {
      if (mode === "custom") { const h = form.elements.hours.value; eff = name + " is banned " + (h === "permanent" ? "until lifted" : "for " + hoursText(h)) + " and kicked now."; }
      else if (r && r.rung && r.rung.outcome === "warn") eff = "That level is only a warning. Use Warn instead.";
      else eff = r && r.rung ? name + " is " + rungText(r.rung) + " and kicked now." : "";
    }
    const out = form.querySelector("[data-effect]");
    if (out) out.textContent = eff;
    const restricted = kind === "ban" && mode !== "custom" && r && r.rung && (r.rung.outcome === "restricted" || r.rung.outcome === "warn");
    for (const b of form.querySelectorAll("button[type=submit]")) b.disabled = !!restricted;
  };
  for (const form of document.querySelectorAll("form.aform")) {
    form.addEventListener("input", () => refresh(form));
    form.addEventListener("change", () => {
      const sel = form.elements.type;
      if (sel && ladder && document.activeElement === sel) { const t = ladder.types.find((x) => x.type === sel.value); const s = t && ladder.suggested[t.type]; if (form.elements.level) form.elements.level.value = String(s || (t ? t.min : 1)); }
      refresh(form);
    });
    refresh(form);
  }
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("button.chip");
    if (!chip) return;
    const form = chip.closest("form");
    if (chip.dataset.fill) { const [k, v] = chip.dataset.fill.split("="); if (form.elements[k]) { form.elements[k].value = v; refresh(form); } return; }
    if (chip.dataset.template) {
      const ta = form.elements.reason; const labels = [...form.querySelectorAll("[data-template]")].map((c) => c.dataset.template);
      const cur = ta.value.trim(); const i = cur.indexOf(SEP);
      const lead = labels.filter((l) => cur === l || cur.startsWith(l + SEP) || cur.startsWith(l + " ")).sort((a, b) => b.length - a.length)[0];
      const note = lead ? cur.slice(lead.length).replace(SEP, "").trim() : cur;
      ta.value = chip.dataset.template + (note ? SEP + note : "");
      ta.focus();
    }
  });

  // Live values (Home): SSE → [data-live=key] and the rooms list.
  const live = document.getElementById("live");
  if (!live || !live.dataset.src) return;
  const show = (v) => (v === null || v === undefined ? "–" : String(v));
  const renderRooms = (box, worlds) => {
    box.replaceChildren();
    if (!worlds.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Nobody online."; box.append(p); return; }
    for (const w of worlds) {
      const card = document.createElement("div"); card.className = "world";
      const h = document.createElement("h3");
      const name = document.createElement("span"); name.textContent = String(w.world);
      const total = document.createElement("span"); total.textContent = String(w.total);
      h.append(name, total);
      const ul = document.createElement("ul");
      for (const r of w.rooms || []) {
        const li = document.createElement("li");
        const a = document.createElement("span"); a.textContent = String(r.room);
        const b = document.createElement("span"); b.textContent = String(r.count);
        li.append(a, b); ul.append(li);
      }
      card.append(h, ul); box.append(card);
    }
  };
  const es = new EventSource(live.dataset.src);
  es.onmessage = (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    for (const [key, value] of Object.entries(data)) {
      if (key === "worlds") continue;
      for (const el of document.querySelectorAll(`[data-live="${CSS.escape(key)}"]`)) el.textContent = show(value);
    }
    const box = document.querySelector("[data-live-rooms]");
    if (box && Array.isArray(data.worlds)) renderRooms(box, data.worlds);
  };
})();
