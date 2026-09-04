// --- CONSTANTS & STATE ---

const EVENT_ID = window.CURRENT_EVENT_ID || "";
const API_PARTICIPANTS = `/api/participants/${EVENT_ID}`;
const API_PRIZES = `/api/prizes/${EVENT_ID}`;
const API_WINNERS = `/api/winners/${EVENT_ID}`;
const PRESENTATION_MODE = window.PRESENTATION_MODE || new URLSearchParams(window.location.search).get("presentation") === "1";
const SPIN_SYNC_KEY = "sltm_raffle_spin_sync";

let participants = Array.isArray(window.INITIAL_PARTICIPANTS) ? window.INITIAL_PARTICIPANTS : [];
let prizes = Array.isArray(window.INITIAL_PRIZES) ? window.INITIAL_PRIZES : [];
let selectedWinners = [];
let pendingPresentationPayload = null;
let spinning = false;
let raffleIndex = 0;
let raffleTimer = null;

const spinButton = document.getElementById("spinButton");
const clearButton = document.getElementById("clearButton");
const winnersList = document.getElementById("winnersList");
const wheelSelectedName = document.getElementById("wheelSelectedName");
const prizeCountBadge = document.getElementById("prizeCountBadge");
const winnerCountBadge = document.getElementById("winnerCountBadge");
const numWinnersInput = document.getElementById("numWinners");
const raffleLoop = document.getElementById("raffleLoop");
const currentPrizeName = document.getElementById("currentPrizeName");
const showAllWinnersButton = document.getElementById("showAllWinnersButton");
const slotLists = Array.from(document.querySelectorAll(".slot-list"));

function sortPrizes(list) {
  return [...list].sort((a, b) => {
    const orderA = Number(a?.sort_order ?? a?.order ?? 0);
    const orderB = Number(b?.sort_order ?? b?.order ?? 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(a?.created_at || "").localeCompare(String(b?.created_at || ""));
  });
}

function sortParticipants(list) {
  return [...list].sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));
}

function sortSelectedWinners(list) {
  return [...list].sort((a, b) => {
    const prizeA = prizes.find((prize) => String(prize.id) === String(a?.prize?.id));
    const prizeB = prizes.find((prize) => String(prize.id) === String(b?.prize?.id));
    const orderA = Number(prizeA?.sort_order ?? prizeA?.order ?? 0);
    const orderB = Number(prizeB?.sort_order ?? prizeB?.order ?? 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(a?.winner?.name || "").localeCompare(String(b?.winner?.name || ""));
  });
}

function getAvailablePrizes() {
  return sortPrizes(prizes.filter((prize) => !selectedWinners.some((entry) => String(entry.prize.id) === String(prize.id))));
}

function getAvailableParticipants() {
  return sortParticipants(participants.filter((person) => !selectedWinners.some((entry) => String(entry.winner.id) === String(person.id))));
}

function isWinnerAlreadySelected(winnerId) {
  return selectedWinners.some((entry) => String(entry.winner.id) === String(winnerId));
}

function setCurrentPrizeDisplay() {
  const activePrize = getAvailablePrizes()[0] || null;
  if (currentPrizeName) {
    currentPrizeName.textContent = activePrize ? activePrize.name : "All prizes awarded";
  }
}

function buildSlotValues(names, count = 13) {
  if (!names.length) return ["Waiting", "Waiting", "Waiting"]; 
  const repeated = [];
  for (let index = 0; index < count; index += 1) {
    repeated.push(names[index % names.length]);
  }
  return repeated;
}

function renderSlots(targetNames) {
  const primaryList = slotLists[0];
  if (!primaryList) return;

  const values = Array.from({ length: 9 }, (_, index) => {
    if (index === 4) return targetNames[0] || "Waiting";
    const fallback = targetNames[0] || "Waiting";
    return fallback;
  });

  primaryList.innerHTML = values
    .map((name, index) => `<div class="slot-item ${index === 4 ? "is-highlighted" : ""}">${name}</div>`)
    .join("");
}

function animateSlotSpin(finalWinnerName, sourceNames = getAvailableParticipants().map((person) => person.name).filter(Boolean)) {
  const availableNames = sourceNames.filter(Boolean);
  if (!availableNames.length) return Promise.resolve();

  const primaryList = slotLists[0];
  if (!primaryList) return Promise.resolve();

  const start = performance.now();
  const duration = 5000;
  primaryList.classList.add("is-spinning");

  return new Promise((resolve) => {
    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const stepNames = availableNames.length ? buildSlotValues(availableNames, 18) : ["Waiting"];
      const offset = Math.min(12, Math.floor(progress * 14));
      const values = [...stepNames.slice(offset), ...stepNames.slice(0, offset)];
      const combined = values.length > 1 ? values : [finalWinnerName];

      primaryList.innerHTML = combined
        .slice(0, 9)
        .map((name, index) => `<div class="slot-item ${index === 4 ? "is-highlighted" : ""}">${name}</div>`)
        .join("");

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        primaryList.classList.remove("is-spinning");
        renderSlots([finalWinnerName]);
        resolve();
      }
    };

    requestAnimationFrame(tick);
  });
}

function publishSpinToPopup(payload) {
  if (!payload || !EVENT_ID) return;
  const data = { ...payload, eventId: EVENT_ID, timestamp: Date.now() };
  localStorage.setItem(SPIN_SYNC_KEY, JSON.stringify(data));
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ type: "sltm_raffle_spin", payload: data }, window.location.origin);
    } catch (error) {}
  }
}

function publishClearToPopup() {
  if (!EVENT_ID) return;
  const data = { type: "clear", eventId: EVENT_ID, timestamp: Date.now() };
  localStorage.setItem(SPIN_SYNC_KEY, JSON.stringify(data));
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ type: "sltm_raffle_clear", payload: data }, window.location.origin);
    } catch (error) {}
  }
}

async function applyPresentationSpin(payload) {
  if (!PRESENTATION_MODE || !payload) return;
  if (payload.eventId && payload.eventId !== EVENT_ID) return;

  const winnerId = payload.winnerId ?? payload.winner?.id;
  const prizeId = payload.prizeId ?? payload.prize?.id;
  const winnerName = payload.winnerName || payload.winner?.name || "Winner";
  const prizeName = payload.prizeName || payload.prize?.name || "Prize";

  if (!winnerId || !prizeId) return;
  if (!Array.isArray(participants) || !Array.isArray(prizes) || !participants.length || !prizes.length) {
    pendingPresentationPayload = payload;
    return;
  }

  const prizeIndex = prizes.findIndex((prize) => String(prize.id) === String(prizeId));
  if (prizeIndex < 0) {
    pendingPresentationPayload = payload;
    return;
  }

  const alreadySelected = selectedWinners.some(
    (item) => String(item.winner.id) === String(winnerId) && String(item.prize.id) === String(prizeId)
  );

  if (isWinnerAlreadySelected(winnerId)) {
    return;
  }

  const spinNames = getAvailableParticipants().map((person) => person.name).filter(Boolean);

  if (!alreadySelected) {
    const winner = participants.find((person) => String(person.id) === String(winnerId)) || {
      id: winnerId,
      name: winnerName,
      company_name: "",
      position: ""
    };
    const prize = prizes.find((item) => String(item.id) === String(prizeId)) || { id: prizeId, name: prizeName };
    selectedWinners = sortSelectedWinners([...selectedWinners, { winner, prize }]);
    updateWinnersUI();
    saveWinnerToServer({ prizeId, winnerId, prizeName, winnerName });
  }

  pendingPresentationPayload = null;
  if (wheelSelectedName) wheelSelectedName.textContent = "Spinning...";
  renderSlots(spinNames);
  spinning = true;
  await animateSlotSpin(winnerName, spinNames);
  spinning = false;
  if (wheelSelectedName) wheelSelectedName.textContent = winnerName;
  setCurrentPrizeDisplay();
}

async function loadData() {
  try {
    const [partRes, prizeRes, winnerRes] = await Promise.all([
      fetch(API_PARTICIPANTS),
      fetch(API_PRIZES),
      fetch(API_WINNERS)
    ]);

    if (!partRes.ok || !prizeRes.ok || !winnerRes.ok) {
      throw new Error("Unable to load raffle data");
    }

    const fetchedParticipants = await partRes.json();
    const fetchedPrizes = await prizeRes.json();
    const fetchedWinners = await winnerRes.json();

    if (!Array.isArray(fetchedParticipants) || !Array.isArray(fetchedPrizes)) {
      throw new Error("Raffle data has an invalid format");
    }

    participants = sortParticipants(fetchedParticipants);
    prizes = sortPrizes(fetchedPrizes);
    selectedWinners = [];

    if (fetchedWinners && typeof fetchedWinners === "object") {
      Object.values(fetchedWinners).forEach((winnerEntry) => {
        const winner = participants.find((person) => String(person.id) === String(winnerEntry.winner_id)) || {
          id: winnerEntry.winner_id,
          name: winnerEntry.winner_name || "Winner",
          company_name: "",
          position: ""
        };
        const prize = prizes.find((item) => String(item.id) === String(winnerEntry.prize_id)) || {
          id: winnerEntry.prize_id,
          name: winnerEntry.prize_name || "Prize"
        };

        if (winnerEntry.prize_id && winnerEntry.winner_id) {
          selectedWinners.push({ winner, prize });
        }
      });
    }
    selectedWinners = sortSelectedWinners(selectedWinners);

    if (prizeCountBadge) {
      prizeCountBadge.innerHTML = `<i data-lucide="gift" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px"></i>${prizes.length} prizes | ${participants.length} participants`;
      if (window.lucide) lucide.createIcons();
    }

    updateRaffleLoop();
    updateWinnersUI();
    setCurrentPrizeDisplay();
    updateButtonState();

    if (numWinnersInput && numWinnersInput.max !== undefined) {
      const maxPicks = Math.min(participants.length, prizes.length);
      if (maxPicks > 0) numWinnersInput.max = maxPicks;
    }

    if (PRESENTATION_MODE && pendingPresentationPayload) {
      applyPresentationSpin(pendingPresentationPayload);
    }

    const availableNames = getAvailableParticipants().map((person) => person.name).filter(Boolean);
    if (availableNames.length) {
      renderSlots(availableNames);
    }
  } catch (error) {
    if (prizeCountBadge) {
      prizeCountBadge.textContent = prizes.length ? `${prizes.length} prizes | refresh unavailable` : "Unable to load prizes";
    }
    if (raffleLoop && !participants.length) {
      raffleLoop.textContent = "Unable to load participants. Please refresh.";
    }
    updateButtonState();
  }
}

function updateButtonState() {
  const availableParticipants = getAvailableParticipants();
  const availablePrizes = getAvailablePrizes();
  if (spinButton) {
    spinButton.disabled = availableParticipants.length === 0 || availablePrizes.length === 0 || spinning;
  }
}

function updateWinnersUI() {
  if (!winnersList) return;
  selectedWinners = sortSelectedWinners(selectedWinners);
  winnersList.innerHTML = "";
  selectedWinners.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-start";
    li.style.animation = "fadeIn 0.5s ease-in-out";
    li.innerHTML = `
      <div class="me-2 w-100">
        <div class="fw-semibold text-primary">${index + 1}. <span class="text-primary">${item.winner.name}</span></div>
        <div class="text-muted small mb-1">${item.winner.company_name || ""} ${item.winner.position ? "· " + item.winner.position : ""}</div>
        <div class="badge bg-success-soft text-white text-wrap text-start mt-1" style="color: #ffffff !important;">
          <i data-lucide="gift" style="width:10px;height:10px;margin-right:2px;vertical-align:-1px; color: #ffffff;"></i>
          Won: ${item.prize.name}
        </div>
      </div>
    `;
    winnersList.appendChild(li);
  });

  if (window.lucide) lucide.createIcons();
  if (winnerCountBadge) winnerCountBadge.textContent = `${selectedWinners.length} selected`;
}

function updateRaffleLoop() {
  if (!raffleLoop) return;
  if (!participants.length) {
    raffleLoop.textContent = "Waiting for participants...";
    return;
  }

  const loopNames = getAvailableParticipants().map((p) => p.name).filter(Boolean);
  if (!loopNames.length) {
    raffleLoop.textContent = "Waiting for participants...";
    return;
  }

  const nextName = loopNames[raffleIndex % loopNames.length];
  raffleLoop.textContent = `Now showing: ${nextName}`;
  raffleIndex += 1;

  if (raffleTimer) clearInterval(raffleTimer);
  raffleTimer = setInterval(() => {
    if (!participants.length || spinning) return;
    const activeNames = getAvailableParticipants().map((p) => p.name).filter(Boolean);
    if (!activeNames.length) return;
    raffleIndex = (raffleIndex + 1) % activeNames.length;
    raffleLoop.textContent = `Now showing: ${activeNames[raffleIndex]}`;
  }, 1400);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveWinnerToServer({ prizeId, winnerId, prizeName, winnerName }) {
  if (!EVENT_ID || !prizeId || !winnerId) return;
  try {
    const response = await fetch(API_WINNERS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prize_id: prizeId, winner_id: winnerId, prize_name: prizeName, winner_name: winnerName })
    });
    if (!response.ok) console.error("Winner save failed:", await response.text());
  } catch (error) {
    console.error("Winner save error:", error);
  }
}

async function spinAndPickLocal() {
  if (spinning || !spinButton || !wheelSelectedName || !clearButton) return;

  const requestedWinners = parseInt(numWinnersInput?.value || "1", 10) || 1;
  const availableParticipants = getAvailableParticipants();
  const availablePrizes = getAvailablePrizes();
  const numWinners = Math.max(1, Math.min(requestedWinners, availableParticipants.length, availablePrizes.length));

  if (!availableParticipants.length || !availablePrizes.length) {
    wheelSelectedName.textContent = "Finished!";
    return;
  }

  spinning = true;
  updateButtonState();
  clearButton.disabled = true;
  spinButton.classList.add("btn-spinning");

  try {
    for (let i = 0; i < numWinners; i += 1) {
      const currentAvailableParticipants = getAvailableParticipants();
      const currentAvailablePrizes = getAvailablePrizes();

      if (!currentAvailableParticipants.length || !currentAvailablePrizes.length) {
        wheelSelectedName.textContent = "Finished!";
        break;
      }

      const thisPrize = currentAvailablePrizes[0];
      const thisWinner = currentAvailableParticipants[Math.floor(Math.random() * currentAvailableParticipants.length)];
      if (isWinnerAlreadySelected(thisWinner.id)) {
        continue;
      }
      const spinNames = currentAvailableParticipants.map((person) => person.name).filter(Boolean);
      if (spinNames.length) {
        wheelSelectedName.innerHTML = '<span class="text-primary">Spinning...</span>';
        renderSlots(spinNames);
        await animateSlotSpin(thisWinner.name);
      }

      selectedWinners = sortSelectedWinners([...selectedWinners, { winner: thisWinner, prize: thisPrize }]);
      saveWinnerToServer({ prizeId: thisPrize.id, winnerId: thisWinner.id, prizeName: thisPrize.name, winnerName: thisWinner.name });
      publishSpinToPopup({ prizeId: thisPrize.id, winnerId: thisWinner.id, prizeName: thisPrize.name, winnerName: thisWinner.name });
      updateWinnersUI();
      setCurrentPrizeDisplay();
      wheelSelectedName.innerHTML = `<span class="text-gradient">${thisWinner.name}</span>`;
      updateButtonState();

      if (i < numWinners - 1) {
        await sleep(1000);
      }
    }
  } finally {
    spinning = false;
    spinButton.classList.remove("btn-spinning");
    clearButton.disabled = false;
    updateButtonState();
    if (getAvailablePrizes().length === 0) {
      wheelSelectedName.innerHTML = '<span class="text-gradient">Complete</span>';
    }
  }
}

function clearPresentationState() {
  selectedWinners = [];
  updateWinnersUI();
  if (wheelSelectedName) wheelSelectedName.textContent = "Ready";
  if (raffleLoop) raffleLoop.textContent = "Now showing: " + (getAvailableParticipants()[0]?.name || "Waiting for participants...");
  setCurrentPrizeDisplay();
  updateButtonState();
}

async function clearWinners() {
  selectedWinners = [];
  updateWinnersUI();
  if (wheelSelectedName) wheelSelectedName.textContent = "Ready";
  if (raffleLoop) raffleLoop.textContent = "Now showing: " + (getAvailableParticipants()[0]?.name || "Waiting for participants...");
  setCurrentPrizeDisplay();
  updateButtonState();
  publishClearToPopup();

  try {
    await fetch(API_WINNERS, { method: "DELETE" });
  } catch (error) {
    console.error("Failed to clear saved winners:", error);
  }
}

if (spinButton) spinButton.addEventListener("click", spinAndPickLocal);
if (clearButton) clearButton.addEventListener("click", clearWinners);
if (showAllWinnersButton) {
  showAllWinnersButton.addEventListener("click", () => {
    const expanded = winnersList?.classList.toggle("winners-list-expanded");
    showAllWinnersButton.innerHTML = expanded
      ? '<i data-lucide="chevron-up" style="width:14px;height:14px;"></i> Hide Winners List'
      : '<i data-lucide="list" style="width:14px;height:14px;"></i> Show Full Winners List';
    if (window.lucide) lucide.createIcons();
  });
}

if (PRESENTATION_MODE) {
  window.addEventListener("storage", (event) => {
    if (event.key !== SPIN_SYNC_KEY || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue);
      if (!payload || payload.eventId !== EVENT_ID) return;
      if (payload.type === "clear") {
        clearPresentationState();
        return;
      }
      applyPresentationSpin(payload);
    } catch (error) {}
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === "sltm_raffle_clear") {
      clearPresentationState();
      return;
    }
    if (event.data && event.data.type === "sltm_raffle_spin") {
      applyPresentationSpin(event.data.payload);
    }
  });
}

if (slotLists.length) {
  loadData();
  setInterval(() => {
    if (!spinning) loadData();
  }, 5000);
}
