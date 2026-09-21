// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState, useCallback } from 'react';
import { buildFleetRoster } from '@/lib/fleet-roster';

interface DeviceSlot {
  slot_type: string;
  slot_id: string;
  name?: string;
  context?: string;
  active_app?: string;
  status?: string;
  task?: string;
  updated_at: string;
  ttl_sec: number;
  [key: string]: unknown;
}

interface DerivedState {
  urgency_mode: string;
  available_modalities: string[];
  preferred_device: string | null;
  suppress_audio: boolean;
  overall_state: string;
  reachability_mode: string;
  computed_at: string;
}

/** What a slot last published before it went quiet. Added beside the string
 *  arrays, which keep their shape; optional because an older API build (or a
 *  cached response) does not send it and an offline chip must still render. */
interface StaleSlotDetail {
  updated_at: string;
  ttl_sec: number;
  source_device: string;
  state: Record<string, unknown>;
}

interface IntentState {
  schema_version: number;
  user_id: string;
  devices: Record<string, DeviceSlot>;
  agents: Record<string, DeviceSlot>;
  stale_devices: string[];
  stale_agents: string[];
  stale_device_details?: Record<string, StaleSlotDetail>;
  stale_agent_details?: Record<string, StaleSlotDetail>;
  derived: DerivedState;
}

interface UserProfile {
  schema_version: number;
  user_id: string;
  personal: Record<string, unknown>;
  preferences: Record<string, unknown>;
  agent_prefs: Record<string, unknown>;
  updated_at: string;
}

// Stopped at hours because a reporting slot is younger than its TTL, so it
// never got there. Offline slots do: the fleet has boxes quiet since spring,
// and "5081h ago" is not a reading anyone takes at a glance. Same wording as
// the rest of the app (src/app/trees/page.tsx switches to weeks at 7 days).
function TimeAgo({ iso }: { iso: string }) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return <span>at an unknown time</span>;
  if (seconds < 0) return <span>just now</span>;
  if (seconds < 60) return <span>{seconds}s ago</span>;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return <span>{minutes}m ago</span>;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return <span>{hours}h ago</span>;
  // Above two days the hour count stops being a quantity anyone reads: a
  // device last seen in May rendered as "3360h ago", which is technically
  // right and tells you nothing. Seen on /dev/fleet?scenario=crowded.
  const days = Math.floor(hours / 24);
  if (days < 60) return <span>{days}d ago</span>;
  const months = Math.floor(days / 30);
  if (months < 24) return <span>{months}mo ago</span>;
  return <span>{Math.floor(months / 12)}y ago</span>;
}

function UrgencyBadge({ mode }: { mode: string }) {
  const colors: Record<string, string> = {
    'normal': 'bg-green-500/20 text-green-400 border-green-500/30',
    'text-only': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    'emergency-only': 'bg-red-500/20 text-red-400 border-red-500/30',
    'silent': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  };
  const style = colors[mode] || colors['normal'];
  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium border ${style}`}>
      {mode}
    </span>
  );
}

function ModalityChip({ modality }: { modality: string }) {
  const icons: Record<string, string> = {
    'voice': '🔊',
    'text': '💬',
    'read': '👁',
    'haptic': '📳',
    'visual': '🖥',
  };
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-sm text-gray-300">
      {icons[modality] || '•'} {modality}
    </span>
  );
}

function deviceIconFor(slot: DeviceSlot): string {
  const id = (slot.slot_id || '').toLowerCase();
  const type = (slot.slot_type || '').toLowerCase();
  const hints = `${id} ${type} ${String(slot.device_type || '')}`.toLowerCase();
  if (hints.includes('watch') || hints.includes('wear')) return '\u231A'; // ⌚
  if (hints.includes('phone') || hints.includes('mobile') || hints.includes('ios') || hints.includes('android')) return '\u{1F4F1}'; // 📱
  if (hints.includes('mini') || hints.includes('server')) return '\u{1F5A5}\uFE0F'; // 🖥️
  return '\u{1F4BB}'; // 💻
}

function freshnessPct(updatedAtIso: string, ttlSec: number): number {
  if (!ttlSec) return 100;
  const ageSec = Math.max(0, (Date.now() - new Date(updatedAtIso).getTime()) / 1000);
  const pct = 100 - (ageSec / ttlSec) * 100;
  return Math.max(0, Math.min(100, pct));
}

type Vitals = { tempC: number | null; loadPct: number | null; load1: number | null; wattsW: number | null };

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function slotPick(slot: DeviceSlot, key: string): unknown {
  const host = slot.host && typeof slot.host === 'object' && !Array.isArray(slot.host)
    ? slot.host as Record<string, unknown>
    : null;
  return slot[key] ?? (host ? host[key] : undefined);
}

function readVitals(slot: DeviceSlot): Vitals {
  return {
    tempC: asNumber(slotPick(slot, 'temp_c')),
    loadPct: asNumber(slotPick(slot, 'load_pct')),
    load1: asNumber(slotPick(slot, 'load_1m')) ?? asNumber(slotPick(slot, 'load1')),
    wattsW: asNumber(slotPick(slot, 'watts_w')),
  };
}

type MemVitals = {
  totalGb: number | null;
  availableGb: number | null;
  availablePct: number | null;
  usedPct: number | null;
};

/** Used = 1 - available/total. Never mem_free: on macOS that is cache, not headroom. */
function readMem(slot: DeviceSlot): MemVitals {
  const total = asNumber(slotPick(slot, 'mem_total_gb'));
  const available = asNumber(slotPick(slot, 'mem_available_gb'));
  if (total === null || total <= 0 || available === null) {
    return { totalGb: total, availableGb: available, availablePct: null, usedPct: null };
  }
  const availablePct = Math.max(0, Math.min(100, (available / total) * 100));
  return { totalGb: total, availableGb: available, availablePct, usedPct: 100 - availablePct };
}

function availabilityColor(availablePct: number): string {
  if (availablePct >= 50) return '#22c55e';
  if (availablePct >= 25) return '#eab308';
  if (availablePct >= 10) return '#f97316';
  return '#d946ef';
}

/**
 * Thermal ceiling for a machine, in C.
 *
 * A publisher that knows its own limit sends `temp_limit_c` — the Sparks read
 * theirs from the GPU and publish 104.8. Everything else falls back to a
 * per-class figure, and the caller marks those as assumed rather than
 * measured, because a bar drawn against a guessed ceiling is a guess.
 */
const ASSUMED_TEMP_LIMIT_C: Array<{ match: RegExp; limitC: number }> = [
  { match: /gpu-server|jetson|dgx|gx10/, limitC: 100 },
  { match: /mac-mini|mac-laptop|macbook|mac-studio|darwin|apple/, limitC: 100 },
  { match: /linux-server|linux|server/, limitC: 95 },
];

type TempVitals = {
  tempC: number;
  limitC: number;
  pctOfLimit: number;
  limitAssumed: boolean;
  /** Where the ceiling came from. A borrowed one is not this slot's measurement. */
  limitSource: 'own' | 'borrowed' | 'assumed';
  /** Which slot published a borrowed ceiling, so the card can say whose it is. */
  limitFrom?: string;
};

/**
 * What the fleet knows about each physical machine, so every slot on a box
 * reads the same ceiling.
 *
 * Two slots can describe one box. An agent reports its host's temperature but
 * not its host's class or, often, its host's limit: hermes sends
 * `host.machine = bosgame-m5` and 72 C and nothing else. Judged alone it fell
 * to a generic default and drew a different colour than the bosgame-m5 device
 * slot sitting next to it, for the same box at the same temperature.
 *
 * So both facts are collected per machine name:
 *  - `limitC`, a ceiling actually published by some slot on that box. Shared,
 *    it still counts as published, because it is that machine's own measured
 *    trip point whichever of its slots sent it.
 *  - `hints`, the hardware words, used only to pick an assumed ceiling when
 *    nothing on the box has published one.
 *
 * Sharing the published limit also rides out publisher cadence: the M5's
 * device slot heartbeats every 30 s and its agents every 300, so after the
 * daemon starts sending a limit there is a window where one slot has it and
 * another does not. Without sharing, one bar would be solid at 66% and its
 * neighbour hatched, for the same box.
 */
type MachineFacts = Record<string, {
  hints?: string;
  limitC?: number;
  /** The donor's own temperature when it published that ceiling. */
  limitTempC?: number;
  /** The donor slot, named so a borrowed ceiling can be attributed. */
  limitFrom?: string;
}>;

/** A ceiling is judged on its own plausibility, never against a reading. */
function plausibleLimit(value: unknown): number | undefined {
  const n = asNumber(value);
  return n !== null && n >= 30 && n <= 200 ? n : undefined;
}

function machineKeyOf(slot: DeviceSlot): string {
  return hostMachineOf(slot) ?? slot.slot_id;
}

function buildMachineFacts(slots: DeviceSlot[]): MachineFacts {
  const out: MachineFacts = {};
  for (const slot of slots) {
    const key = machineKeyOf(slot);
    const entry = out[key] || (out[key] = {});
    if (entry.hints === undefined) {
      const hints = [slot.kind, slot.slot_type, slot.hw]
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (hints) entry.hints = hints;
    }
    if (entry.limitC === undefined) {
      const published = plausibleLimit(slotPick(slot, 'temp_limit_c'));
      if (published !== undefined) {
        entry.limitC = published;
        // Keep the donor's own reading and name. A ceiling is only safely
        // shared with a slot that is reading the same sensor, and the only
        // evidence of that available here is that the two readings agree.
        entry.limitTempC = asNumber(slotPick(slot, 'temp_c')) ?? undefined;
        entry.limitFrom = slot.name || slot.slot_id;
      }
    }
  }
  return out;
}

function readTemp(slot: DeviceSlot, facts: MachineFacts = {}): TempVitals | null {
  const tempC = asNumber(slotPick(slot, 'temp_c'));
  if (tempC === null) return null;
  const machine = facts[machineKeyOf(slot)];

  // This slot's own published ceiling first. If it has none, a ceiling
  // published by another slot on the same box may apply - but only if the two
  // are plausibly reading the same sensor, and the only evidence of that here
  // is that their temperatures agree.
  //
  // @codexmb caught the earlier version of this (2026-09-17): it borrowed a
  // ceiling from any slot on the same machine and left limitAssumed false, so
  // a borrowed number was drawn exactly like a published one. Two slots on one
  // box can easily read different sensors - a CPU package and a GPU die differ
  // by tens of degrees and have different limits - and sharing a ceiling
  // between them produces a confident, wrong percentage.
  const CORROBORATION_C = 3;
  const own = plausibleLimit(slotPick(slot, 'temp_limit_c'));
  let limitC: number | null = own ?? null;
  let limitSource: 'own' | 'borrowed' | 'assumed' = 'own';
  let limitFrom: string | undefined;

  if (limitC === null && machine?.limitC !== undefined) {
    const donorTemp = machine.limitTempC;
    const agrees = donorTemp !== undefined && Math.abs(tempC - donorTemp) <= CORROBORATION_C;
    if (agrees) {
      limitC = machine.limitC;
      limitSource = 'borrowed';
      limitFrom = machine.limitFrom;
    }
  }

  let limitAssumed = limitSource === 'borrowed';
  if (limitC === null) {
    const hints = [slot.kind, slot.slot_type, slot.hw, slot.slot_id, machine?.hints]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    limitC = ASSUMED_TEMP_LIMIT_C.find((row) => row.match.test(hints))?.limitC ?? 100;
    limitAssumed = true;
    limitSource = 'assumed';
    limitFrom = undefined;
  }
  return {
    tempC,
    limitC,
    pctOfLimit: Math.max(0, Math.min(100, (tempC / limitC) * 100)),
    limitAssumed,
    limitSource,
    limitFrom,
  };
}

/**
 * Temperature colour by closeness to that machine's own limit, at the owner's
 * request: green / yellow / orange / fuchsia. Same four colours the memory
 * and CPU meters use, so one glance reads the same way across all three bars.
 */
function tempColor(pctOfLimit: number): string {
  if (pctOfLimit < 60) return '#22c55e';
  if (pctOfLimit < 75) return '#eab308';
  if (pctOfLimit < 90) return '#f97316';
  return '#d946ef';
}

type HistoryPoint = {
  at?: string;
  load_pct?: number;
  mem_pct?: number;
};

/** Server history, keyed "device:macbook" / "agent:claudemm". mem_pct is available, not used. */
type HistorySeries = Record<string, HistoryPoint[]>;

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 64;
  const h = 20;
  if (values.length < 2) {
    return <svg width={w} height={h} className="shrink-0" aria-hidden />;
  }
  const n = values.length - 1;
  const d = values
    .map((v, i) => {
      const x = (i / n) * w;
      const y = h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One 0-100% bar on a single row: label, track, reading.
 *
 * Every bar on the page is the same width and the same scale, so machines can
 * be compared down a column without reading the numbers.
 */
function Meter({
  label,
  fillPct,
  color,
  reading,
  title,
  history,
  estimatedScale = false,
}: {
  label: string;
  fillPct: number;
  color: string;
  reading: string;
  title?: string;
  history?: number[];
  /** Hatch the track when the 100% end is assumed rather than published. */
  estimatedScale?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0" title={title}>
      <span className="w-8 shrink-0 text-[11px] uppercase tracking-wider text-gray-400">{label}</span>
      <div
        className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden min-w-0"
        style={
          estimatedScale
            ? {
                backgroundImage:
                  'repeating-linear-gradient(135deg, rgba(255,255,255,0.14) 0 2px, transparent 2px 5px)',
              }
            : undefined
        }
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.max(0, Math.min(100, fillPct))}%`, background: color }}
        />
      </div>
      {history && history.length > 1 && <Sparkline values={history} color={color} />}
      <span className="w-14 shrink-0 text-right text-[11px] font-mono tabular-nums" style={{ color }}>
        {reading}
      </span>
    </div>
  );
}

function usedHistory(points: HistoryPoint[] | undefined, kind: 'cpu' | 'mem'): number[] {
  if (!points) return [];
  const out: number[] = [];
  for (const p of points) {
    if (kind === 'cpu') {
      if (typeof p.load_pct === 'number' && Number.isFinite(p.load_pct)) out.push(p.load_pct);
    } else if (typeof p.mem_pct === 'number' && Number.isFinite(p.mem_pct)) {
      // Stored as available/total. Meter is used, so invert.
      out.push(Math.max(0, Math.min(100, 100 - p.mem_pct)));
    }
  }
  return out;
}

/** CPU, memory and temperature as three bars on the same scale. */
function ResourceMeters({ slot, type, history, facts }: { slot: DeviceSlot; type: 'device' | 'agent'; history: HistorySeries; facts: MachineFacts }) {
  const vitals = readVitals(slot);
  const mem = readMem(slot);
  const temp = readTemp(slot, facts);
  const cpuUsed = vitals.loadPct;
  const points = history[`${type}:${slot.slot_id}`] || [];
  if (cpuUsed === null && mem.usedPct === null && temp === null) return null;
  return (
    <div className="space-y-1.5">
      {cpuUsed !== null && (
        <Meter
          label="cpu"
          fillPct={cpuUsed}
          color={availabilityColor(Math.max(0, 100 - cpuUsed))}
          reading={`${Math.round(cpuUsed)}%`}
          history={usedHistory(points, 'cpu')}
        />
      )}
      {mem.usedPct !== null && mem.availablePct !== null && (
        <Meter
          label="mem"
          fillPct={mem.usedPct}
          color={availabilityColor(mem.availablePct)}
          reading={`${Math.round(mem.usedPct)}%`}
          title={
            mem.availableGb !== null && mem.totalGb !== null
              ? `${trimNum(mem.availableGb)} GB free of ${trimNum(mem.totalGb)} GB`
              : undefined
          }
          history={usedHistory(points, 'mem')}
        />
      )}
      {temp && (
        <Meter
          label="temp"
          fillPct={temp.pctOfLimit}
          color={tempColor(temp.pctOfLimit)}
          reading={`${trimNum(temp.tempC)}°`}
          estimatedScale={temp.limitAssumed}
          title={
            temp.limitSource === 'own'
              ? `${trimNum(temp.tempC)} C, ${Math.round(temp.pctOfLimit)}% of its published ${trimNum(temp.limitC)} C limit`
              : temp.limitSource === 'borrowed'
                ? `${trimNum(temp.tempC)} C. Scale is borrowed: this slot publishes no limit of its own, so the bar runs to the ${trimNum(temp.limitC)} C published by ${temp.limitFrom ?? 'another slot on the same machine'}, whose reading agrees with this one (${Math.round(temp.pctOfLimit)}%).`
                : `${trimNum(temp.tempC)} C. Scale is estimated: this machine does not publish its own limit, so the bar runs to an assumed ${trimNum(temp.limitC)} C (${Math.round(temp.pctOfLimit)}%).`
          }
        />
      )}
    </div>
  );
}

function ExtraValue({ value }: { value: unknown }) {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const href = typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#99DD00] text-xs font-mono truncate max-w-[60%] text-right underline underline-offset-2 hover:text-[#b8f03a]"
      >
        {text.replace(/^https?:\/\//i, '')}
      </a>
    );
  }
  return (
    <span className="text-gray-200 text-xs font-mono truncate max-w-[60%] text-right">
      {text}
    </span>
  );
}

/**
 * The physical machine a slot belongs to.
 *
 * Publishers send `host` either as a vitals object carrying a `machine` name
 * or, on publishers not yet updated, as a bare machine-name string.
 */
function hostMachineOf(slot: DeviceSlot): string | undefined {
  const host = slot.host;
  if (typeof host === 'string') return host;
  if (host && typeof host === 'object' && !Array.isArray(host)) {
    const machine = (host as Record<string, unknown>).machine;
    if (typeof machine === 'string') return machine;
  }
  return undefined;
}

/**
 * Total watts across the fleet, counting each machine once.
 *
 * An agent is a process running on a device, so the same physical box can
 * appear twice — once as a device slot, once as the agent living on it. Adding
 * both would report double the power actually drawn.
 *
 * Slots are keyed by the machine name their publisher reports, falling back to
 * the slot id. This is only as good as that name: `source_device` cannot be
 * used as the join key because publishers disagree about it (one agent reports
 * its own handle, another reports the host machine), so an agent that sends no
 * `machine` still cannot be matched to its device. Publishers that send one —
 * anything on the shared UIK host-vitals path — dedupe correctly.
 */
function totalWatts(slots: DeviceSlot[]): number | null {
  const perMachine = new Map<string, number>();
  for (const slot of slots) {
    const watts = readVitals(slot).wattsW;
    if (watts === null) continue;
    const key = hostMachineOf(slot) ?? slot.slot_id;
    if (!perMachine.has(key)) perMachine.set(key, watts);
  }
  if (perMachine.size === 0) return null;
  return [...perMachine.values()].reduce((a, b) => a + b, 0);
}

/** RAM GB ≈ params(B) × bits/8 × 1.1 (weights + ~10% ctx/overhead). */
function ramNeedGb(paramsB: number, bits: number): number {
  return paramsB * (bits / 8) * 1.1;
}

/**
 * Size class + quant from installed RAM. Not a brand name.
 * denseQ8B = total / 1.1; moe3bitB = total / (3/8 × 1.1).
 * Suggest Q8 when dense class is usable, Q3 when you want max MoE size.
 * Never uses macOS mem_free_gb.
 */
function classLine(gb: number): string {
  const denseQ8 = gb / 1.1;
  const moe3 = gb / ramNeedGb(1, 3);
  const moe4 = gb / ramNeedGb(1, 4);
  return `~${trimNum(denseQ8)} B dense Q8, or ~${trimNum(moe3)} B MoE 3-bit (~${trimNum(moe4)} B at 4-bit)`;
}

// A user asked: "what is missing is what model the machine is running
// (if any), you could have it in short form after device name". The model was
// already published and already parsed here, but only inside the prose note
// behind "details". This surfaces it on the card itself. Deliberately lossless:
// strip the path and the file extension, nothing else, and keep the full string
// in the title so a truncated name is still readable on hover.
function shortModelName(slot: DeviceSlot): { short: string; full: string } | null {
  const host = slot.host && typeof slot.host === 'object' && !Array.isArray(slot.host)
    ? slot.host as Record<string, unknown>
    : {};
  const raw = slot['model'] ?? host['model'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const full = raw.trim();
  const base = full.split('/').pop() || full;
  const short = base.replace(/\.(gguf|safetensors|bin)$/i, '');
  return short ? { short, full } : null;
}

function localModelNote(slot: DeviceSlot): string | null {
  const host = slot.host && typeof slot.host === 'object' && !Array.isArray(slot.host)
    ? slot.host as Record<string, unknown>
    : {};
  const pick = (key: string): unknown => slot[key] ?? host[key];
  const model = typeof pick('model') === 'string' ? String(pick('model')) : '';
  const total = asNumber(pick('mem_total_gb'));
  const available = asNumber(pick('mem_available_gb'));
  if (total === null) return null;
  const serving = model ? `Already serving ${model.split('/').pop() || model}. ` : '';
  const cap = available ?? total;
  const denseQ8 = cap / 1.1;
  const quant = total < 16
    ? 'Under 16 GB: Gemma-class 2–12B dense. Q8 if you stay under the dense ceiling, Q4 for the larger 9–12B end.'
    : denseQ8 >= 20
      ? 'Suggest Q5–Q8 under that dense size, or Q3 if you want the larger MoE class.'
      : 'Suggest Q3–Q4 MoE/A3B to stay inside this box; Q8 dense will be small.';
  const now = available !== null
    ? `Fits now (${trimNum(available)} GB available): ${classLine(available)}. `
    : '';
  const ifFree = `If you free other work (${trimNum(total)} GB installed): ${classLine(total)}. `;
  return `${serving}${now}${ifFree}${quant}`;
}

function trimNum(value: number): string {
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

/**
 * Machines that are not reporting right now, as one wrapped row of chips.
 *
 * They were full-size cards, so six quiet boxes pushed the live ones off the
 * screen — the opposite of what this page is for. They still have to be
 * visible, because a machine that went quiet is information, but they do not
 * need a card each.
 *
 * Deliberately neutral, in wording and in colour. The API calls these "stale",
 * meaning only that no heartbeat arrived inside the TTL, and for a machine
 * that comes and goes — the car, a phone — that is its normal resting state
 * rather than a fault. A user reported: "just bc it's not currently online
 * does not mean the handle is stale". Red borders and the word "stale" made a
 * parked car look broken.
 */
function OfflineChips({ ids, icon, type, details }: {
  ids: string[];
  icon: string;
  type: 'device' | 'agent';
  details?: Record<string, StaleSlotDetail>;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map(id => {
        const detail = details?.[id];
        // The published state has the same shape a live slot does, so the
        // model reads through the same helper the live cards use rather than
        // a second rule that could disagree with them.
        const model = detail
          ? shortModelName({
              ...detail.state,
              slot_type: type,
              slot_id: id,
              updated_at: detail.updated_at,
              ttl_sec: detail.ttl_sec,
            } as DeviceSlot)
          : null;
        const title = detail
          ? `${id} — offline, no heartbeat inside its ${detail.ttl_sec}s TTL. `
            + `Last seen ${detail.updated_at}`
            + (model ? `, running ${model.full}` : '')
            + (detail.source_device && detail.source_device !== id ? `, published by ${detail.source_device}` : '')
          : `${id} — offline, no heartbeat inside its TTL`;
        return (
          <span
            key={id}
            // gray-400, not gray-500: at 11px on this background gray-500
            // came out around 4:1, under the 4.5:1 AA floor. The two spans
            // below were gray-600 when this chip was written; they are one
            // step up for the same reason, since they sit at 10-11px too.
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-white/10 bg-white/[0.03] text-[11px] text-gray-400"
            title={title}
          >
            <span className="opacity-60">{icon}</span>
            {id}
            {detail && (
              <span className="text-gray-500">
                offline, last seen <TimeAgo iso={detail.updated_at} />
              </span>
            )}
            {/* Same badge the live cards put beside a device name (font, size,
                truncation, title), dimmed to the chip's neutral grey: an
                offline box must not draw the eye harder than a working one.
                Agents follow the live cards too - their model stays in the
                tooltip, as it stays behind "details" on a card. */}
            {model && type === 'device' && (
              <span className="shrink min-w-0 truncate text-[10px] font-mono text-gray-500" title={model.full}>
                {model.short}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function SlotCard({ slot, type, isStale, isPreferred, history, facts }: { slot: DeviceSlot; type: 'device' | 'agent'; isStale: boolean; isPreferred?: boolean; history: HistorySeries; facts: MachineFacts }) {
  const vitals = readVitals(slot);
  const machine = hostMachineOf(slot);
  // Anything already drawn as a bar or printed on the context line, so
  // "details" carries what the card does not already show.
  const knownKeys = new Set([
    'slot_type', 'slot_id', 'name', 'updated_at', 'ttl_sec', 'source_device',
    'schema_version', 'user_id', 'temp_c', 'temp_limit_c', 'watts_w', 'load1', 'load_1m',
    'load_pct', 'cpu_count', 'host', 'machine',
    'mem_total_gb', 'mem_available_gb',
    'active_app', 'context', 'lan_ip', 'network',
  ]);

  // Agents nest their remaining vitals (memory, disk, uptime) inside `host`,
  // devices publish them at the top level. Flatten so both render the same,
  // otherwise everything an agent reports beyond the headline pills is
  // invisible.
  const hostFields = slot.host && typeof slot.host === 'object' && !Array.isArray(slot.host)
    ? (slot.host as Record<string, unknown>)
    : {};

  const extraFields = Object.entries({ ...slot, ...hostFields }).filter(
    ([key, value]) => !knownKeys.has(key) && value !== undefined && value !== null
  );

  const modelNote = type === 'device' ? localModelNote(slot) : null;
  const runningModel = type === 'device' ? shortModelName(slot) : null;
  const fresh = freshnessPct(slot.updated_at, slot.ttl_sec);
  const freshColor = fresh > 60 ? 'bg-green-500' : fresh > 25 ? 'bg-yellow-500' : 'bg-orange-500';
  const icon = type === 'device' ? deviceIconFor(slot) : '\u{1F916}';

  // One compact line of context under the bars: where it is and what it is
  // doing. Everything else moves behind "details" so a card stays the height
  // of its three bars and many machines fit one screen.
  const context = [
    typeof slot.active_app === 'string' ? slot.active_app : null,
    typeof slot.context === 'string' ? slot.context : null,
    typeof slot.lan_ip === 'string' ? slot.lan_ip : null,
    typeof slot.network === 'string' ? slot.network : null,
    vitals.wattsW !== null ? `${trimNum(vitals.wattsW)} W` : null,
  ].filter((s): s is string => Boolean(s));

  return (
    <div
      className={`relative flex flex-col gap-2 p-3 rounded-xl border transition-colors ${
        isStale
          ? 'border-amber-500/25 bg-amber-500/[0.04] opacity-60'
          : isPreferred
            ? 'border-[#99DD00]/40 bg-[#99DD00]/[0.07]'
            : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-base leading-none shrink-0">{icon}</span>
        <span className="font-semibold text-white text-sm truncate">{slot.name || slot.slot_id}</span>
        {runningModel && (
          <span
            // flex-1 (basis 0), not shrink: both spans were shrinkable at the
            // same rate, so a 60-character model path ate the card's own title
            // - "m5" rendered as "m" and "gpu-server-01" as "gpu-..." while the
            // model kept 193px of its 336. The machine's name is the card's
            // identity and the model is an annotation on it. With a zero basis
            // the model claims only what is LEFT OVER after the name, so the
            // name never truncates while any room remains, and a name long
            // enough to fill the row still truncates rather than overflowing.
            // Measured on /dev/fleet?scenario=crowded.
            className="flex-1 min-w-0 truncate text-[10px] font-mono text-[#99DD00]/80"
            title={runningModel.full}
          >
            {runningModel.short}
          </span>
        )}
        {isPreferred && (
          <span className="shrink-0 text-[9px] uppercase tracking-wider font-semibold text-[#99DD00]">pref</span>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${isStale ? 'bg-amber-500' : 'bg-green-500'}`} />
          <TimeAgo iso={slot.updated_at} />
        </span>
      </div>

      <ResourceMeters slot={slot} type={type} history={history} facts={facts} />

      {context.length > 0 && (
        <div className="text-[11px] text-gray-400 truncate" title={context.join(' · ')}>
          {context.join(' · ')}
        </div>
      )}

      {(extraFields.length > 0 || modelNote || machine) && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] uppercase tracking-wider text-gray-500 hover:text-gray-300">
            details
          </summary>
          <div className="mt-2 space-y-1 text-xs">
            {machine && machine !== slot.slot_id && (
              <div className="flex justify-between gap-3">
                <span className="text-gray-500">machine</span>
                <span className="text-gray-200 font-mono truncate max-w-[60%] text-right">{machine}</span>
              </div>
            )}
            {extraFields.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-3">
                <span className="text-gray-500 capitalize">{key.replace(/_/g, ' ')}</span>
                <ExtraValue value={value} />
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">freshness</span>
              <span className="text-gray-200 font-mono">{Math.round(fresh)}% · TTL {slot.ttl_sec}s</span>
            </div>
            {modelNote && <p className="text-[11px] text-gray-400 leading-relaxed pt-1">{modelNote}</p>}
          </div>
        </details>
      )}

      <div className="absolute inset-x-0 bottom-0 h-0.5 rounded-b-xl bg-white/5 overflow-hidden" aria-hidden>
        <div className={`h-full ${freshColor} transition-all`} style={{ width: `${fresh}%` }} />
      </div>
    </div>
  );
}

export function IntentDashboard({
  userId,
  apiKey,
  baseUrl = '/api/v1',
}: {
  userId: string;
  apiKey: string | null;
  /** Overridable so the dashboard can be rendered against a non-default API host. */
  baseUrl?: string;
}) {
  const [intent, setIntent] = useState<IntentState | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [history, setHistory] = useState<HistorySeries>({});

  const fetchIntent = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['X-API-Key'] = apiKey;
      const res = await fetch(`${baseUrl}/intent/${userId}`, { headers });
      if (!res.ok) throw new Error(`Intent API ${res.status}`);
      const data = await res.json();
      setIntent(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch intent');
    }
  }, [userId, apiKey, baseUrl]);

  const fetchHistory = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['X-API-Key'] = apiKey;
      const res = await fetch(`${baseUrl}/intent/${userId}/history?hours=24`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.series === 'object' && data.series) {
        setHistory(data.series as HistorySeries);
      }
    } catch {
      // Graph is decoration; cards still show live meters.
    }
  }, [userId, apiKey, baseUrl]);

  const fetchProfile = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['X-API-Key'] = apiKey;
      const res = await fetch(`${baseUrl}/profile/${userId}`, { headers });
      if (!res.ok) throw new Error(`Profile API ${res.status}`);
      const data = await res.json();
      setProfile(data);
    } catch {
      // Profile fetch is non-critical
    }
  }, [userId, apiKey, baseUrl]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      await Promise.all([fetchIntent(), fetchProfile(), fetchHistory()]);
      setLoading(false);
    }
    load();
  }, [fetchIntent, fetchProfile, fetchHistory]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchIntent, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchIntent]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchHistory, 60000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchHistory]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-pulse text-gray-500">Loading intent state...</div>
      </div>
    );
  }

  if (error && !intent) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center">
        <p className="text-red-400">{error}</p>
        <button onClick={fetchIntent} className="mt-4 px-4 py-2 bg-white/10 rounded-lg text-sm hover:bg-white/20">
          Retry
        </button>
      </div>
    );
  }

  if (!intent) return null;

  // ONE builder produces every collection on this page, and every count below
  // is the `.length` of the array rendered right under it. The header used to
  // read `intent.stale_devices.length` while the chips rendered
  // `intent.stale_devices.filter(id => !intent.devices[id])`: two expressions
  // over the same data, free to disagree, and they did. It also folds
  // case-duplicate agent rows and drops placeholder registrations, sorted by
  // name rather than recency so cards do not jump under the cursor on a poll.
  // See src/lib/fleet-roster.ts.
  const roster = buildFleetRoster<DeviceSlot>(intent);
  const activeDevices = roster.devices;
  const activeAgents = roster.agents;
  const offlineDevices = roster.offlineDevices;
  const offlineAgents = roster.offlineAgents;
  const staleDeviceSet = new Set(offlineDevices);
  const staleAgentSet = new Set(offlineAgents);
  const isEmpty = activeDevices.length === 0 && activeAgents.length === 0 && offlineDevices.length === 0 && offlineAgents.length === 0;
  const fleetSlots = [...activeDevices, ...activeAgents];
  // One box can have several slots; they share its ceiling and its class.
  const facts = buildMachineFacts(fleetSlots);
  const fleetVitals = fleetSlots.map(readVitals);
  const temps = fleetVitals.map((v) => v.tempC).filter((n): n is number => n !== null);
  const loads = fleetVitals.map((v) => v.loadPct).filter((n): n is number => n !== null);
  // Hottest and peak load are maxima, so a machine appearing as both a device
  // and an agent is harmless. Power is a sum and must not double-count it.
  const wattsTotal = totalWatts(fleetSlots);

  return (
    <div className="space-y-4">
      {/* Getting Started - shown when everything is empty */}
      {isEmpty && (
        <section className="bg-gradient-to-br from-[#99DD00]/10 to-[#FF9900]/10 border border-[#99DD00]/20 rounded-2xl p-6 space-y-4">
          <h2 className="text-xl font-semibold text-white">Getting Started</h2>
          <p className="text-gray-300 text-sm leading-relaxed">
            This dashboard shows a live view of all your devices and AI agents in one place.
            They report their state here automatically so you always know what is active and what each one is doing.
          </p>
          <div className="grid md:grid-cols-3 gap-4 text-sm">
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
              <div className="text-lg">&#x2328;&#xFE0F;</div>
              <div className="font-medium text-white">Connect a device</div>
              <p className="text-gray-400 text-xs">ClawWatch, IDE extensions, or any app using the User Intent Kit reports your device context automatically.</p>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
              <div className="text-lg">&#x1F916;</div>
              <div className="font-medium text-white">Add agents</div>
              <p className="text-gray-400 text-xs">AI agents publish their status here so you can see what they are working on and coordinate across tools.</p>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
              <div className="text-lg">&#x1F527;</div>
              <div className="font-medium text-white">Automatic</div>
              <p className="text-gray-400 text-xs">Your devices and agents update this page automatically. No manual setup needed on your end.</p>
            </div>
          </div>
        </section>
      )}

      {/* Derived state and fleet totals, one strip: the machines are the page. */}
      <section className="rounded-2xl border border-white/10 bg-gradient-to-r from-[#99DD00]/10 via-purple-500/[0.07] to-blue-500/10 px-4 py-3">
        <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="text-xl font-bold text-white capitalize leading-none">
              {(intent.derived.overall_state || 'unknown').replace('_', ' ')}
            </h2>
            <span className="text-sm font-medium text-[#FFC84D] capitalize truncate">
              {(intent.derived.reachability_mode || 'unknown').replace(/_/g, ' ')}
            </span>
          </div>

          <UrgencyBadge mode={intent.derived.urgency_mode} />

          <span className="text-xs text-gray-400">
            pref <span className="text-white font-medium">{intent.derived.preferred_device || 'none'}</span>
          </span>

          <span className={`inline-flex items-center gap-1.5 text-xs ${intent.derived.suppress_audio ? 'text-red-400' : 'text-green-400'}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${intent.derived.suppress_audio ? 'bg-red-500' : 'bg-green-500'}`} />
            audio {intent.derived.suppress_audio ? 'off' : 'on'}
          </span>

          <div className="flex flex-wrap gap-1">
            {intent.derived.available_modalities.map(m => (
              <ModalityChip key={m} modality={m} />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-4 shrink-0">
            <span className="text-xs font-mono text-gray-400 tabular-nums">
              {activeDevices.length}d · {activeAgents.length}a
              {temps.length > 0 && <> · max {trimNum(Math.max(...temps))}&deg;</>}
              {loads.length > 0 && <> · peak {Math.max(...loads)}%</>}
              {wattsTotal !== null && <> · {trimNum(wattsTotal)} W</>}
            </span>
            {error && <span className="text-xs text-red-400">refresh failed</span>}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border transition ${
                autoRefresh ? 'border-green-500/40 text-green-400 bg-green-500/10' : 'border-gray-500/30 text-gray-400'
              }`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
              {autoRefresh ? 'Live' : 'Paused'}
            </button>
          </div>
        </div>
      </section>

      {/* Devices */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-2">
          Devices
          <span className="ml-2 text-xs font-normal text-gray-500">
            {activeDevices.length} reporting, {offlineDevices.length} offline
          </span>
        </h2>
        {activeDevices.length === 0 && offlineDevices.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-white/10 rounded-xl">
            <p className="text-gray-500">No devices reporting yet.</p>
            <p className="text-gray-600 text-xs mt-2">Devices appear here when ClawWatch, an IDE extension, or any app publishes state via the intent API.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {activeDevices.map(slot => (
              <SlotCard
                key={slot.slot_id}
                slot={slot}
                type="device"
                isStale={staleDeviceSet.has(slot.slot_id)}
                isPreferred={intent.derived.preferred_device === slot.slot_id}
                history={history}
                facts={facts}
              />
            ))}
          </div>
        )}
        <OfflineChips ids={offlineDevices} icon={'\u{1F4BB}'} type="device" details={intent.stale_device_details} />
      </section>

      {/* Agents */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-2">
          Agents
          <span className="ml-2 text-xs font-normal text-gray-500">
            {activeAgents.length} reporting, {offlineAgents.length} offline
          </span>
        </h2>
        {activeAgents.length === 0 && offlineAgents.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-white/10 rounded-xl">
            <p className="text-gray-500">No agents reporting yet.</p>
            <p className="text-gray-600 text-xs mt-2">AI agents appear here when they publish their status, so you can see what each one is working on.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {activeAgents.map(slot => (
              <SlotCard key={slot.slot_id} slot={slot} type="agent" isStale={staleAgentSet.has(slot.slot_id)} history={history} facts={facts} />
            ))}
          </div>
        )}
        <OfflineChips ids={offlineAgents} icon={'\u{1F916}'} type="agent" details={intent.stale_agent_details} />
      </section>

      {/* Profile */}
      {profile && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-2">User Profile</h2>
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 space-y-4">
            {Object.keys(profile.personal || {}).length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-2">Personal</h3>
                <pre className="text-xs text-gray-300 font-mono bg-black/40 p-3 rounded-lg overflow-x-auto">
                  {JSON.stringify(profile.personal, null, 2)}
                </pre>
              </div>
            )}
            {Object.keys(profile.preferences || {}).length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-2">Preferences</h3>
                <pre className="text-xs text-gray-300 font-mono bg-black/40 p-3 rounded-lg overflow-x-auto">
                  {JSON.stringify(profile.preferences, null, 2)}
                </pre>
              </div>
            )}
            {Object.keys(profile.personal || {}).length === 0 && Object.keys(profile.preferences || {}).length === 0 && (
              <p className="text-gray-500 text-sm">Profile is empty. Set your preferences (quiet hours, response style, notification preferences) via the API to personalize how agents interact with you.</p>
            )}
            <div className="text-xs text-gray-500">
              Last updated: {profile.updated_at ? new Date(profile.updated_at).toLocaleString() : 'never'}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
