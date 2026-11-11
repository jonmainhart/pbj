"use strict";

import { loadAnnouncements } from "./announcements.js";
import { initializeDocumentCards } from "./document-card.js";
import { isForegroundCardOpen } from "./foreground-card.js";

import { fetchAvailableWeeks, fetchSeason, fetchWeek } from "./data.js";

import {
  getPlayerName,
  loadSeasonPlayerNames,
  rememberPlayerNames,
} from "./players.js";

import {
  resetWeeklyNavigation,
  initializeWeeklyInteractions,
} from "./weekly-controller.js";

import { renderWeeklyView } from "./weekly.js";

import { renderSeason } from "./season.js";

import { initializeAutoRefresh } from "./refresh.js";

const SEASON = 2026;

let currentWeekData = null;
let seasonData = null;
let seasonLoading = false;
let availableWeeks = [];
let followLatest = true;
let selectionInitialized = false;
let selectionVersion = 0;
let refreshPending = false;
let weekLoading = false;

document.addEventListener("DOMContentLoaded", async () => {
  initializeTabs();
  initializeWeeklyInteractions();
  initializeDocumentCards();
  loadAnnouncements();

  initializeWeekSelector();
  initializeAutoRefresh(refreshCurrentWeek);
  if (document.hidden) return;
  refreshPending = true;
  try {
    reconcileWeeks(await fetchAvailableWeeks());

    if (availableWeeks.length === 0) {
      setText("#weekly-message", "No weeks are available yet.");
      return;
    }

    const requestedWeek = getRequestedWeek(availableWeeks);

    selectionInitialized = true;
    followLatest = requestedWeek === availableWeeks.at(-1);
    document.querySelector("#week-select").value = String(requestedWeek);

    updateWeekQueryString(requestedWeek);
    await loadWeek(requestedWeek);
  } catch (error) {
    setText(
      "#weekly-message",
      error instanceof Error
        ? error.message
        : "Unable to load available weeks.",
    );
  } finally {
    refreshPending = false;
  }
});

async function refreshCurrentWeek() {
  if (document.hidden || refreshPending) return;
  refreshPending = true;
  const version = selectionVersion;
  try {
    try {
      reconcileWeeks(await fetchAvailableWeeks());
    } catch {
      // A manifest failure must not interrupt live score refreshes.
    }
    if (
      document.hidden || weekLoading || isForegroundCardOpen() ||
      version !== selectionVersion
    ) return;

    const select = document.querySelector("#week-select");
    if (!availableWeeks.length) return;
    const selected = Number(select.value);
    let week = selected;
    if (!selectionInitialized) {
      week = getRequestedWeek(availableWeeks);
    } else if (followLatest || !availableWeeks.includes(selected)) {
      week = availableWeeks.at(-1);
    }
    if (!week) return;
    const data = await fetchWeek(SEASON, week);
    if (
      document.hidden || weekLoading || isForegroundCardOpen() ||
      version !== selectionVersion
    ) return;

    if (!selectionInitialized) {
      selectionInitialized = true;
      followLatest = week === availableWeeks.at(-1);
    }

    if (week !== selected) {
      select.value = String(week);
      updateWeekQueryString(week);
      resetWeeklyNavigation();
    }
    if (JSON.stringify(data) === JSON.stringify(currentWeekData)) return;
    currentWeekData = data;
    seasonData = null;
    rememberPlayerNames(data.players ?? [], week);
    renderWeeklyView(data, getPlayerName);
    setText("#weekly-message", "");
  } catch {
    // Keep displaying the existing data if refresh fails; retry next time.
  } finally {
    refreshPending = false;
  }
}

function reconcileWeeks(manifest) {
  const weeks = manifest?.[String(SEASON)];
  if (!Array.isArray(weeks) || !weeks.length ||
      !weeks.every((week) => Number.isInteger(week) && week > 0)) return;
  const next = [...new Set(weeks)].sort((a, b) => a - b);
  if (JSON.stringify(next) === JSON.stringify(availableWeeks)) return;
  const select = document.querySelector("#week-select");
  const selected = select.value;
  availableWeeks = next;
  seasonData = null;
  const options = next.map((week) => {
    const option = document.createElement("option");
    option.value = String(week);
    option.textContent = String(week);
    return option;
  });
  select.replaceChildren(...options);
  // Preserve the display until a replacement week has loaded successfully.
  select.value = selected;
}

function initializeWeekSelector() {
  const select = document.querySelector("#week-select");
  select.addEventListener("change", () => {
    const week = Number(select.value);
    selectionInitialized = true;
    followLatest = week === availableWeeks.at(-1);
    updateWeekQueryString(week);
    loadWeek(week);
  });
}

function initializeTabs() {
  const weeklyTab = document.querySelector("#weekly-tab");
  const seasonTab = document.querySelector("#season-tab");

  weeklyTab.addEventListener("click", () => {
    resetWeeklyNavigation();
    showView("weekly");
  });

  seasonTab.addEventListener("click", async () => {
    resetWeeklyNavigation();
    showView("season");

    if (seasonData === null) {
      await loadSeason();
    }
  });
}

function showView(view) {
  const weeklyTab = document.querySelector("#weekly-tab");
  const seasonTab = document.querySelector("#season-tab");

  const weeklyView = document.querySelector("#weekly-view");
  const seasonView = document.querySelector("#season-view");

  const showingWeekly = view === "weekly";

  weeklyView.hidden = !showingWeekly;
  seasonView.hidden = showingWeekly;

  weeklyTab.classList.toggle("active", showingWeekly);
  seasonTab.classList.toggle("active", !showingWeekly);

  weeklyTab.setAttribute("aria-selected", String(showingWeekly));

  seasonTab.setAttribute("aria-selected", String(!showingWeekly));
}

async function loadWeek(week) {
  const version = ++selectionVersion;
  weekLoading = true;
  resetWeeklyNavigation("players");

  setText("#week-heading", `Week ${week}`);
  setText("#week-status", "Loading…");
  setText("#weekly-message", "");

  const playerList = document.querySelector("#player-list");
  const summary = document.querySelector("#weekly-summary");

  playerList.replaceChildren();
  document.querySelector("#game-list").replaceChildren();
  summary.replaceChildren();

  try {
    const data = await fetchWeek(SEASON, week);
    if (version !== selectionVersion) return;
    currentWeekData = data;

    rememberPlayerNames(currentWeekData.players ?? [], week);

    renderWeeklyView(currentWeekData, getPlayerName);
  } catch (error) {
    if (version !== selectionVersion) return;
    setText("#week-status", `Week ${week}`);

    setText(
      "#weekly-message",
      error instanceof Error ? error.message : "Unable to load this week.",
    );
  } finally {
    if (version === selectionVersion) weekLoading = false;
  }
}

async function loadSeason() {
  if (seasonLoading) return;
  seasonLoading = true;
  setText("#season-message", "Loading season standings…");

  try {
    const data = await fetchSeason(SEASON);

    await loadSeasonPlayerNames(
      data.players ?? [],
      data.weeks_scored ?? [],
      (week) => fetchWeek(SEASON, week, { reuse: true }),
    );

    seasonData = data;
    renderSeason(data, getPlayerName);
  } catch (error) {
    setText(
      "#season-message",
      error instanceof Error
        ? error.message
        : "Unable to load season standings.",
    );
  } finally {
    seasonLoading = false;
  }
}

function getRequestedWeek(availableWeeks) {
  const params = new URLSearchParams(window.location.search);

  const requested = Number(params.get("week"));

  if (Number.isInteger(requested) && availableWeeks.includes(requested)) {
    return requested;
  }

  return Math.max(...availableWeeks);
}

function updateWeekQueryString(week) {
  const url = new URL(window.location.href);

  url.searchParams.set("week", String(week));

  window.history.replaceState({}, "", url);
}

function setText(selector, text) {
  const element = document.querySelector(selector);

  element.textContent = text;
}
