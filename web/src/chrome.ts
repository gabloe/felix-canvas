import { stateHash } from "@felix-canvas/model";
import {
  ALargeSmall,
  Bold,
  Check,
  ChevronDown,
  Circle,
  ExternalLink,
  EyeOff,
  Hand,
  Heading,
  Italic,
  Keyboard,
  Link,
  List,
  ListOrdered,
  Lock,
  LogOut,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Pencil,
  Plus,
  Slash,
  Square,
  Sun,
  Trash2,
  Type,
  Underline,
  X,
  createIcons,
} from "lucide";

import type { Editor, Tool } from "./editor.js";
import type { RoomMember } from "./members.js";
import { MAX_NAME, PEER_COLORS, paletteIndex, type Peer } from "./peers.js";
import { OPS, type Session } from "./session.js";

type Theme = "system" | "light" | "dark";

/** Unacknowledged edits older than this turn the chip to "Saving". */
const SAVING_AFTER_MS = 300;
/** Brief drops stay quiet: the chip says "Reconnecting" only after this. */
const RECONNECT_GRACE_MS = 800;
/** How long "Up to date" shows after catching up. */
const CONVERGED_MS = 2000;
/** How long the notice stays after catching up from a slow connection. */
const CAUGHT_UP_NOTICE_MS = 3000;
const MAX_AVATARS = 4;
const TOOLTIP_DELAY_MS = 500;
/** Joins and leaves are announced only in rooms smaller than this. */
const ANNOUNCE_BELOW = 10;
/** Matches the avatar's shrink transition. */
const AVATAR_LEAVE_MS = 200;

/** Someone shown in the avatar stack and the people list. */
interface Person {
  key: string;
  name: string;
  color: string;
  you: boolean;
  /** "You", "Active" or "Away", with how long for. */
  status: string;
}

const element = <T extends Element = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;

/**
 * Everything around the canvas. Numbers refresh at most four times a second
 * and every slot has a fixed width, so state changes never move the layout.
 */
export class Chrome {
  /** Called when the theme changed and the canvas must reread its colours. */
  onThemeChange: () => void = () => {};
  /** Called when this person chose a new name. */
  onRename: (name: string) => void = () => {};
  /** Called to sign in, again or as someone else. */
  onSignIn: () => void = () => {};

  readonly #session: Session;
  readonly #editor: Editor;
  #name: string;
  #ownColor = 0;
  #peers: Peer[] = [];
  #members: RoomMember[] = [];
  /** Other members' names by session, once the first list has arrived. */
  #known: Map<bigint, string> | null = null;
  readonly #person: bigint;
  readonly #avatarNodes = new Map<string, HTMLElement>();
  #pendingSince: number | null = null;
  #disconnectedAt: number | null = null;
  #metrics: { browser: number; felix: number } | null = null;
  /** The replica's position when catching up began, for the progress bars. */
  #catchUpFrom: number | null = null;
  #convergedAt: number | null = null;
  #fellBehindSeen = 0;
  /** The slow-connection notice: catching up, or caught up with the version reached. */
  #notice: { version: string | null; applied: number; until: number } | null = null;
  #toastTimer = 0;
  #account = { who: "", room: "" };
  /** The room's name, for a room people made, which only has an id in Felix. */
  #title: string | null = null;
  /** Whether Share copies the room's address, rather than opening a panel. */
  #shareCopies = true;

  constructor(session: Session, editor: Editor, name: string, person: bigint) {
    this.#person = person;
    this.#session = session;
    this.#editor = editor;
    this.#name = name;
    createIcons({
      icons: {
        ALargeSmall,
        Bold,
        Check,
        ChevronDown,
        Circle,
        ExternalLink,
        EyeOff,
        Hand,
        Heading,
        Italic,
        Keyboard,
        Link,
        List,
        ListOrdered,
        Lock,
        LogOut,
        Minus,
        Monitor,
        Moon,
        MousePointer2,
        Pencil,
        Type,
        Plus,
        Slash,
        Square,
        Sun,
        Trash2,
        Underline,
        X,
      },
    });
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
      for (const node of document.querySelectorAll("kbd, [data-key]")) {
        if (node instanceof HTMLElement && node.dataset.key) {
          node.dataset.key = node.dataset.key.replaceAll("⌘", "Ctrl").replaceAll("⌥", "Alt");
        } else if (node.textContent) {
          node.textContent = node.textContent.replaceAll("⌘", "Ctrl ").replaceAll("⌥", "Alt ");
        }
      }
    }
    this.#wireToolbar();
    this.#wireMenu();
    this.#wireStatus();
    this.#wirePeople();
    this.#wireTooltips();
    this.#wireKeys();
    element("switch-account-item").addEventListener("click", () => this.onSignIn());
    element("share").addEventListener("click", () => {
      if (this.#shareCopies) void this.#share();
    });
    element("zoom-in").addEventListener("click", () => editor.zoomBy(1.25, undefined, true));
    element("zoom-out").addEventListener("click", () => editor.zoomBy(0.8, undefined, true));
    element("zoom-reset").addEventListener("click", () =>
      editor.zoomBy(1 / editor.camera.zoom, undefined, true),
    );
    this.#applyTheme(this.#savedTheme());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
      this.onThemeChange(),
    );
    setInterval(() => this.refresh(), 250);
  }

  /** Show a short message above the toolbar. */
  toast(message: string): void {
    const toast = element("toast");
    toast.textContent = message;
    toast.classList.add("shown");
    clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => toast.classList.remove("shown"), 2000);
  }

  /** Cursor activity changed, which decides who shows as away. */
  setPeers(peers: Peer[]): void {
    this.#peers = peers;
    this.#renderPeople();
  }

  /** The member list changed, or this session's palette index did. */
  setMembers(members: RoomMember[], ownColor: number): void {
    this.#members = members;
    this.#ownColor = ownColor;
    // Keyed by person, so a reload or a second tab is not a join or a leave.
    const others = new Map(
      this.#others().map((entries) => [entries[0]!.person, entries.at(-1)!.name]),
    );
    if (this.#known && others.size + 1 < ANNOUNCE_BELOW) {
      for (const [person, name] of others) {
        if (!this.#known.has(person)) this.toast(`${name} joined`);
      }
      for (const [person, name] of this.#known) {
        if (!others.has(person)) this.toast(`${name} left`);
      }
    }
    this.#known = others;
    this.#renderPeople();
  }

  /** Reflect the editor's tool and zoom. */
  syncEditor(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === this.#editor.tool));
    }
    element("zoom-reset").textContent = `${Math.round(this.#editor.camera.zoom * 100)}%`;
  }

  /** Who is signed in, and the room they asked for. */
  setAccount(who: string, room: string): void {
    this.#account = { who, room };
    element("account-label").textContent = who ? `Signed in as ${who}` : "";
  }

  /** Show `title` as the room's name. */
  setRoomTitle(title: string): void {
    this.#title = title;
    this.refresh();
  }

  /** Open `panel` from the Share button instead of copying the room's address. */
  shareWith(panel: HTMLElement, onToggle: (open: boolean) => void): void {
    this.#shareCopies = false;
    element("share").dataset.tip = "Invite people and see who has access";
    element("share").setAttribute("aria-haspopup", "dialog");
    popover(element("share"), panel, onToggle);
  }

  /** Update the room name, cards, chip and status numbers. */
  refresh(): void {
    const session = this.#session;
    const now = performance.now();
    if (session.refused) {
      showAccess(session.refused, { ...this.#account, onSignIn: () => this.onSignIn() });
      return;
    }
    if (session.room) {
      const name = this.#title ?? session.room.room;
      element("workspace").textContent = session.room.namespace;
      element("room").textContent = name;
      element("status-room").textContent = name;
      document.title = `${name} · Felix Canvas`;
    }

    if (session.connection === "reconnecting") this.#disconnectedAt ??= now;
    else this.#disconnectedAt = null;
    const pending = session.replica.pending.length;
    if (pending === 0) this.#pendingSince = null;
    else this.#pendingSince ??= now;

    if (!session.caughtUp && !session.loading) this.#catchUpFrom ??= session.replica.next;
    if (session.caughtUp && this.#catchUpFrom !== null) {
      this.#catchUpFrom = null;
      this.#convergedAt = now;
    }
    const progress = this.#progress();
    this.#renderNotice(progress, now);

    const card = !session.hasFrame || session.rebuilding;
    element("joining").hidden = !card;
    element("app").classList.toggle("rebuilding", session.rebuilding);
    element("empty").hidden =
      !session.caughtUp || session.replica.view().shapes.size > 0 || this.#editor.draft !== null;
    if (card) this.#renderJoining(progress);

    let state: string;
    let label: string;
    if (this.#disconnectedAt !== null && now - this.#disconnectedAt > RECONNECT_GRACE_MS) {
      [state, label] = ["reconnecting", "Reconnecting"];
    } else if (session.connection === "connecting") {
      [state, label] = ["connecting", "Connecting"];
    } else if (session.rebuilding) {
      [state, label] = ["behind", "Rebuilding"];
    } else if (!session.caughtUp) {
      [state, label] = [
        "behind",
        progress ? `Catching up ${progress.left.toLocaleString()}` : "Loading",
      ];
    } else if (this.#convergedAt !== null && now - this.#convergedAt < CONVERGED_MS) {
      [state, label] = ["converged", "Up to date"];
    } else if (this.#pendingSince !== null && now - this.#pendingSince > SAVING_AFTER_MS) {
      [state, label] = ["saving", `Saving ${pending}`];
    } else {
      const rtt = session.editTrips.quantile(0.5) ?? session.cursorTrips.quantile(0.5);
      [state, label] = ["live", rtt === null ? "Live" : `Live · ${formatMs(rtt)}`];
    }
    const chip = element("chip");
    chip.dataset.state = state;
    element("chip-label").textContent = label;
    element("chip-bar").style.width =
      state === "behind" && progress ? `${progress.fraction * 100}%` : "0";

    if (!element("status").hidden) this.#renderStatus();
    // "Away" carries a duration, so it ages even when nothing else changes.
    this.#renderPeople();
  }

  /** How far catching up has got, once the session knows where it started. */
  #progress(): { left: number; fraction: number } | null {
    if (this.#catchUpFrom === null) return null;
    const total = this.#session.tail + 1 - this.#catchUpFrom;
    const done = this.#session.replica.next - this.#catchUpFrom;
    return {
      left: Math.max(0, total - done),
      fraction: total <= 0 ? 1 : Math.min(1, done / total),
    };
  }

  /**
   * Changes went missing because this tab read too slowly. Say so plainly,
   * count the catch-up, and end on the version reached, which another
   * window's Sync panel can be compared against.
   */
  #renderNotice(progress: { left: number; fraction: number } | null, now: number): void {
    const session = this.#session;
    if (session.fellBehind !== this.#fellBehindSeen) {
      this.#fellBehindSeen = session.fellBehind;
      this.#notice = { version: null, applied: -1, until: Infinity };
    }
    // Changes still on their way when the tab caught up land while the notice
    // shows, so its version follows them rather than the moment of catching up.
    const applied = session.replica.next;
    if (this.#notice && session.caughtUp && this.#notice.applied !== applied) {
      this.#notice = {
        version: stateHash(session.replica.confirmed).slice(0, 4),
        applied,
        until: this.#notice.version === null ? now + CAUGHT_UP_NOTICE_MS : this.#notice.until,
      };
    }
    if (this.#notice && now > this.#notice.until) this.#notice = null;

    const notice = this.#notice;
    const box = element("behind");
    box.hidden = notice === null;
    if (!notice) return;
    box.dataset.state = notice.version === null ? "behind" : "caught-up";
    if (notice.version === null) {
      element("behind-title").textContent = "Your connection is slow";
      element("behind-detail").textContent = progress
        ? `Catching up on ${progress.left.toLocaleString()} changes`
        : "Catching up";
      element("behind-bar").style.width = `${(progress?.fraction ?? 0) * 100}%`;
    } else {
      element("behind-title").textContent = "Back in sync";
      element("behind-detail").textContent = `Up to date · version ${notice.version}`;
      element("behind-bar").style.width = "100%";
    }
  }

  #renderJoining(progress: { left: number; fraction: number } | null): void {
    const session = this.#session;
    const room = session.room?.room;
    const detail = element("joining-detail");
    element("joining-title").textContent = session.rebuilding
      ? `Rebuilding ${room ?? "the canvas"}`
      : room
        ? `Joining ${room}`
        : "Joining the room";
    element("joining-bar").style.width = `${(progress?.fraction ?? 0) * 100}%`;
    if (session.connection !== "live") {
      detail.textContent = session.connection === "connecting" ? "Connecting" : "Reconnecting";
    } else if (!progress) {
      detail.textContent = "Loading the canvas";
    } else if (session.rebuilding) {
      detail.textContent = `Loading the canvas: ${progress.left.toLocaleString()} recent changes`;
    } else {
      const total = session.tail + 1;
      const done = Math.min(session.replica.next, total);
      detail.textContent = `Loading the canvas: ${done.toLocaleString()} of ${total.toLocaleString()} changes`;
    }
  }

  #renderStatus(): void {
    const session = this.#session;
    const edit = session.editTrips;
    const p50 = edit.quantile(0.5);
    const p99 = edit.quantile(0.99);
    element("status-tail").textContent = (session.tail + 1).toLocaleString();
    element("status-applied").textContent = session.replica.next.toLocaleString();
    element("status-edit").textContent =
      p50 === null || p99 === null ? "no changes yet" : `${formatMs(p50)} · p99 ${formatMs(p99)}`;
    const cursor = session.cursorTrips.quantile(0.5);
    element("status-cursor").textContent = cursor === null ? "none" : formatMs(cursor);
    element("status-browser").textContent = this.#metrics
      ? formatMs(this.#metrics.browser)
      : "none";
    element("status-server").textContent = this.#metrics ? formatMs(this.#metrics.felix) : "none";
    element("status-hash").textContent = stateHash(session.replica.confirmed);
    element("status-people").textContent = this.#people().length.toLocaleString();
    element("throttle").setAttribute("aria-checked", String(session.throttled));

    const samples = edit.latest(60);
    const max = Math.max(1, ...samples);
    const step = samples.length > 1 ? 280 / (samples.length - 1) : 0;
    const points = samples.map(
      (ms, i) => `${(i * step).toFixed(1)},${(30 - (ms / max) * 28).toFixed(1)}`,
    );
    element<SVGSVGElement>("status-spark")
      .querySelector("polyline")!
      .setAttribute("points", points.join(" "));
  }

  /**
   * Everyone else's entries, grouped by person, oldest entry first. A person
   * with two tabs, or a reloaded tab whose old entry has not expired, has
   * more than one.
   */
  #others(): RoomMember[][] {
    const byPerson = new Map<bigint, RoomMember[]>();
    for (const member of this.#members) {
      if (member.person === this.#person) continue;
      byPerson.set(member.person, [...(byPerson.get(member.person) ?? []), member]);
    }
    return [...byPerson.values()];
  }

  #people(): Person[] {
    const now = performance.now();
    const others = this.#others().map((entries) => {
      const newest = entries.at(-1)!;
      const peers = entries.flatMap(
        (entry) => this.#peers.find((peer) => peer.sid === entry.sid) ?? [],
      );
      const lastMove = Math.max(...peers.map((peer) => peer.lastMove));
      return {
        key: newest.person.toString(16),
        name: newest.name,
        color: PEER_COLORS[paletteIndex(newest.color)]!,
        you: false,
        status: peers.some((peer) => !peer.idle)
          ? "Active"
          : away(peers.length > 0 ? now - lastMove : null),
      };
    });
    const you = {
      key: "you",
      name: this.#name,
      color: PEER_COLORS[this.#ownColor]!,
      you: true,
      status: "You",
    };
    return [...others, you];
  }

  #renderPeople(): void {
    const people = this.#people();
    this.#renderAvatars(people);
    element("people-title").textContent =
      people.length === 1 ? "Just you here" : `${people.length} people here`;
    const you = element("you-avatar");
    you.style.setProperty("--peer", PEER_COLORS[this.#ownColor]!);
    you.textContent = initial(this.#name);
    const rows = people
      .filter((person) => !person.you)
      .map((person) => {
        const row = document.createElement("li");
        row.className = "person";
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.style.setProperty("--peer", person.color);
        avatar.textContent = initial(person.name);
        const name = document.createElement("span");
        name.className = "person-name";
        name.textContent = person.name;
        const status = document.createElement("span");
        status.className = "person-status";
        status.dataset.active = String(person.status === "Active");
        status.textContent = person.status;
        row.append(avatar, name, status);
        return row;
      });
    element("people-list").replaceChildren(...rows);
  }

  /**
   * The avatar stack, updated in place so a newcomer pops in and someone who
   * left shrinks away instead of the whole row redrawing.
   */
  #renderAvatars(people: Person[]): void {
    const shown = people.length > MAX_AVATARS ? people.slice(0, MAX_AVATARS - 1) : people;
    const entries = shown.map((person) => ({
      key: person.key,
      label: initial(person.name),
      color: person.color,
      dim: person.status !== "Active" && !person.you,
      tip: person.you
        ? `${person.name} (you)`
        : person.status === "Active"
          ? person.name
          : `${person.name} · ${person.status}`,
    }));
    if (people.length > shown.length) {
      const rest = people.slice(shown.length);
      entries.push({
        key: "more",
        label: `+${rest.length}`,
        color: "",
        dim: false,
        tip: rest.map((person) => person.name).join(", "),
      });
    }
    const container = element("avatars");
    let previous: HTMLElement | null = null;
    for (const entry of entries) {
      let avatar = this.#avatarNodes.get(entry.key);
      if (!avatar) {
        avatar = document.createElement("span");
        avatar.className = entry.key === "more" ? "avatar more" : "avatar";
        this.#avatarNodes.set(entry.key, avatar);
      }
      avatar.classList.toggle("idle", entry.dim);
      avatar.style.setProperty("--peer", entry.color);
      avatar.textContent = entry.label;
      avatar.dataset.tip = entry.tip;
      const next: ChildNode | null = previous ? previous.nextSibling : container.firstChild;
      if (avatar !== next) container.insertBefore(avatar, next);
      previous = avatar;
    }
    const keep = new Set(entries.map((entry) => entry.key));
    for (const [key, avatar] of this.#avatarNodes) {
      if (keep.has(key)) continue;
      this.#avatarNodes.delete(key);
      avatar.classList.add("leaving");
      setTimeout(() => avatar.remove(), AVATAR_LEAVE_MS);
    }
    element("avatars").setAttribute(
      "aria-label",
      people.length === 1 ? "Just you here" : `${people.length} people here`,
    );
  }

  #wireToolbar(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.addEventListener("click", () => this.#editor.setTool(button.dataset.tool as Tool));
    }
    this.syncEditor();
  }

  #wireMenu(): void {
    const button = element("menu-button");
    const menu = element("menu");
    const setOpen = (open: boolean) => {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", () => setOpen(Boolean(menu.hidden)));
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !button.contains(target)) setOpen(false);
    });
    for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
      choice.addEventListener("click", () => {
        const theme = choice.dataset.themeChoice as Theme;
        try {
          localStorage.setItem("felix-canvas.theme", theme);
        } catch {
          // Private windows may refuse storage; the theme still applies now.
        }
        this.#applyTheme(theme);
      });
    }
    element("shortcuts-item").addEventListener("click", () => {
      setOpen(false);
      this.#showShortcuts();
    });
    const cursors = element("cursors-item");
    cursors.addEventListener("click", () => {
      const shown = cursors.getAttribute("aria-checked") !== "true";
      cursors.setAttribute("aria-checked", String(shown));
      element("cursors").hidden = !shown;
    });
    element("hide-ui-item").addEventListener("click", () => {
      setOpen(false);
      this.#toggleUi();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    const dialog = element<HTMLDialogElement>("shortcuts");
    dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  #wireStatus(): void {
    let poll = 0;
    popover(element("chip"), element("status"), (open) => {
      clearInterval(poll);
      if (open) {
        void this.#fetchMetrics();
        poll = window.setInterval(() => void this.#fetchMetrics(), 1000);
        this.#renderStatus();
      }
    });
    element("throttle").addEventListener("click", () => {
      this.#session.setThrottled(!this.#session.throttled);
      this.#renderStatus();
    });
  }

  #wirePeople(): void {
    const input = element<HTMLInputElement>("you-name");
    input.maxLength = MAX_NAME;
    popover(element("avatars"), element("people"), (open) => {
      if (open) input.value = this.#name;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        input.value = this.#name;
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      const name = input.value.trim().slice(0, MAX_NAME);
      input.value = name || this.#name;
      if (!name || name === this.#name) return;
      this.#name = name;
      this.onRename(name);
      this.#renderPeople();
    });
  }

  async #fetchMetrics(): Promise<void> {
    try {
      const response = await fetch("/metrics");
      type Summary = { p50_us: number; count: number };
      const body = (await response.json()) as {
        browser_rtt?: Summary;
        felix_publish_ack?: Record<string, Summary>;
      };
      const browser = body.browser_rtt;
      const felix = body.felix_publish_ack?.[OPS];
      if (browser && felix)
        this.#metrics = { browser: browser.p50_us / 1000, felix: felix.p50_us / 1000 };
    } catch {
      this.#metrics = null;
    }
  }

  #wireTooltips(): void {
    const tooltip = element("tooltip");
    let timer = 0;
    let lastHidden = 0;
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      if (current) lastHidden = performance.now();
      current = null;
      tooltip.classList.remove("shown");
    };
    const show = (target: HTMLElement) => {
      tooltip.replaceChildren(target.dataset.tip ?? "");
      if (target.dataset.key) {
        const key = document.createElement("kbd");
        key.textContent = target.dataset.key;
        tooltip.append(key);
      }
      const rect = target.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      const below = rect.top < window.innerHeight / 2;
      const left = Math.max(
        8,
        Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2),
      );
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${below ? rect.bottom + 8 : rect.top - box.height - 8}px`;
      tooltip.classList.add("shown");
    };
    document.addEventListener("pointerover", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      if (target === current) return;
      hide();
      if (!target || target.closest('[aria-expanded="true"]')) return;
      current = target;
      // Moving between neighbouring buttons shows the next tip at once.
      const delay = performance.now() - lastHidden < 300 ? 0 : TOOLTIP_DELAY_MS;
      timer = window.setTimeout(() => show(target), delay);
    });
    document.addEventListener("pointerdown", hide);
  }

  #wireKeys(): void {
    window.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (event.key === "?") {
        event.preventDefault();
        this.#showShortcuts();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        this.#toggleUi();
      }
    });
  }

  #showShortcuts(): void {
    const dialog = element<HTMLDialogElement>("shortcuts");
    if (!dialog.open) dialog.showModal();
  }

  #toggleUi(): void {
    document.getElementById("app")!.classList.toggle("ui-hidden");
  }

  async #share(): Promise<void> {
    try {
      await navigator.clipboard.writeText(location.href);
      this.toast("Link copied");
    } catch {
      this.toast("Copy the address bar to share this room");
    }
  }

  #savedTheme(): Theme {
    const theme = document.documentElement.dataset.theme;
    return theme === "light" || theme === "dark" ? theme : "system";
  }

  #applyTheme(theme: Theme): void {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
      choice.setAttribute("aria-checked", String(choice.dataset.themeChoice === theme));
    }
    this.onThemeChange();
  }
}

/** Open and close `panel` from `trigger`, closing it on any click outside both. */
export function popover(
  trigger: HTMLElement,
  panel: HTMLElement,
  onToggle: (open: boolean) => void,
): void {
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    onToggle(open);
  };
  trigger.addEventListener("click", () => setOpen(Boolean(panel.hidden)));
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!panel.hidden && !panel.contains(target) && !trigger.contains(target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden && !(event.target instanceof HTMLInputElement)) {
      setOpen(false);
      trigger.focus();
    }
  });
}

function initial(name: string): string {
  return [...name][0]?.toUpperCase() ?? "?";
}

/** How long someone has been away, in the coarse words a person would use. */
function away(ms: number | null): string {
  if (ms === null || ms < 60_000) return "Away";
  if (ms < 3_600_000) return `Away · ${Math.floor(ms / 60_000)}m`;
  return `Away · ${Math.floor(ms / 3_600_000)}h`;
}

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/**
 * Replace the canvas with a card saying why this room cannot be opened:
 * `forbidden` when the signed-in person is not a member, `signed_out` when
 * their sign-in has ended or did not finish.
 */
export function showAccess(
  state: "signed_out" | "forbidden",
  view: { who: string; room: string; onSignIn: () => void; detail?: string },
): void {
  const card = element("access");
  if (card.dataset.state === state) return;
  card.dataset.state = state;
  element("app").classList.add("refused");
  for (const id of ["joining", "empty"]) element(id).hidden = true;
  const forbidden = state === "forbidden";
  element("access-title").textContent = forbidden
    ? "You don't have access to this canvas"
    : "Sign in to open this canvas";
  element("access-detail").textContent = forbidden
    ? `Ask whoever shared “${view.room}” with you to add you, or sign in with an account that has access.`
    : (view.detail ?? "Your sign-in has ended. Sign in again to pick up where you left off.");
  const primary = element<HTMLButtonElement>("access-primary");
  primary.textContent = forbidden ? "Switch account" : "Sign in";
  primary.onclick = view.onSignIn;
  element("access-lobby").hidden = !forbidden || view.room === "lobby";
  element("access-who").textContent = forbidden && view.who ? `Signed in as ${view.who}` : "";
  card.hidden = false;
  primary.focus();
}
