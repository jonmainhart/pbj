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

document.addEventListener("DOMContentLoaded", async () => {
  initializeTabs();
  initializeWeeklyInteractions();
  initializeDocumentCards();
  loadAnnouncements();

  try {
    const manifest = await fetchAvailableWeeks();
    const availableWeeks = manifest[String(SEASON)] ?? [];

    if (availableWeeks.length === 0) {
      setText("#weekly-message", "No weeks are available yet.");
      return;
    }

    initializeWeekSelector(availableWeeks);

    const requestedWeek = getRequestedWeek(availableWeeks);

    document.querySelector("#week-select").value = String(requestedWeek);

    updateWeekQueryString(requestedWeek);
    await loadWeek(requestedWeek);
    initializeAutoRefresh(refreshCurrentWeek);
  } catch (error) {
    setText(
      "#weekly-message",
      error instanceof Error
        ? error.message
        : "Unable to load available weeks.",
    );
  }
});

async function refreshCurrentWeek() {
  if (isForegroundCardOpen()) {
    return;
  }

  const week = Number(document.querySelector("#week-select").value);

  try {
    const data = await fetchWeek(SEASON, week);

    // A card may have opened or the selected week changed while fetching.
    if (
      isForegroundCardOpen() ||
      Number(document.querySelector("#week-select").value) !== week
    ) {
      return;
    }

    if (JSON.stringify(data) === JSON.stringify(currentWeekData)) {
      return;
    }

    currentWeekData = data;
    seasonData = null;

    rememberPlayerNames(data.players ?? [], week);
    renderWeeklyView(data, getPlayerName);
  } catch {
    // Keep displaying the existing data if refresh fails.
  }
}

function initializeWeekSelector(availableWeeks) {
  const select = document.querySelector("#week-select");

  for (const week of availableWeeks) {
    const option = document.createElement("option");

    option.value = String(week);
    option.textContent = String(week);

    select.append(option);
  }

  select.addEventListener("change", () => {
    const week = Number(select.value);

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
    currentWeekData = await fetchWeek(SEASON, week);

    rememberPlayerNames(currentWeekData.players ?? [], week);

    renderWeeklyView(currentWeekData, getPlayerName);
  } catch (error) {
    setText("#week-status", `Week ${week}`);

    setText(
      "#weekly-message",
      error instanceof Error ? error.message : "Unable to load this week.",
    );
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
