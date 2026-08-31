// --- CONSTANTS & STATE ---

const EVENT_ID = window.CURRENT_EVENT_ID || "";
const API_PARTICIPANTS = `/api/participants/${EVENT_ID}`;
const API_PRIZES = `/api/prizes/${EVENT_ID}`;
const PRESENTATION_MODE = window.PRESENTATION_MODE || new URLSearchParams(window.location.search).get("presentation") === "1";
const SPIN_SYNC_KEY = "sltm_raffle_spin_sync";

let participants = Array.isArray(window.INITIAL_PARTICIPANTS) ? window.INITIAL_PARTICIPANTS : [];
let prizes = Array.isArray(window.INITIAL_PRIZES) ? window.INITIAL_PRIZES : [];
let selectedWinners = [];
let pendingPresentationPayload = null;
let spinning = false;
let raffleIndex = 0;
let raffleTimer = null;

const canvas = document.getElementById("wheelCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const spinButton = document.getElementById("spinButton");
const clearButton = document.getElementById("clearButton");
const winnersList = document.getElementById("winnersList");
const wheelSelectedName = document.getElementById("wheelSelectedName");
const prizeCountBadge = document.getElementById("prizeCountBadge");
const winnerCountBadge = document.getElementById("winnerCountBadge");
const numWinnersInput = document.getElementById("numWinners");
const raffleLoop = document.getElementById("raffleLoop");

function publishSpinToPopup(payload) {
  if (!payload || !EVENT_ID) return;

  const data = { ...payload, eventId: EVENT_ID, timestamp: Date.now() };
  localStorage.setItem(SPIN_SYNC_KEY, JSON.stringify(data));

  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ type: "sltm_raffle_spin", payload: data }, window.location.origin);
    } catch (error) {
      // Ignore cross-window postMessage issues when the opener is unavailable.
    }
  }
}

function publishClearToPopup() {
  if (!EVENT_ID) return;

  const data = {
    type: "clear",
    eventId: EVENT_ID,
    timestamp: Date.now()
  };

  localStorage.setItem(SPIN_SYNC_KEY, JSON.stringify(data));

  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage({ type: "sltm_raffle_clear", payload: data }, window.location.origin);
    } catch (error) {
      // Ignore cross-window postMessage issues when the opener is unavailable.
    }
  }
}

function animateWheelToPrize(prizeIndex, winnerName, finishText, updateCenterText = true) {
  if (!ctx || !canvas || prizeIndex < 0 || !prizes.length) return Promise.resolve();

  const duration = 2500;
  const start = performance.now();

  return new Promise((resolve) => {
    function step(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const randomExtraSpins = Math.PI * 8;
      const sliceAngle = (2 * Math.PI) / prizes.length;
      const targetAngleForTop = -Math.PI / 2;
      const winnerCenterAngle = prizeIndex * sliceAngle + sliceAngle / 2;
      const endRotation = randomExtraSpins + (targetAngleForTop - winnerCenterAngle);
      const currentAngle = eased * endRotation;

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(currentAngle);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);
      drawWheel();
      ctx.restore();

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(step);
  }).then(() => {
    if (updateCenterText && wheelSelectedName) {
      wheelSelectedName.innerHTML = finishText || `<span class="text-gradient">${winnerName || "Winner"}</span>`;
    }
  });
}

function applyPresentationSpin(payload) {
  if (!PRESENTATION_MODE || !payload) return;

  if (payload.eventId && payload.eventId !== EVENT_ID) {
    return;
  }

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

  if (!alreadySelected) {
    const winner = participants.find((person) => String(person.id) === String(winnerId)) || {
      id: winnerId,
      name: winnerName,
      company_name: "",
      position: ""
    };
    const prize = prizes.find((item) => String(item.id) === String(prizeId)) || {
      id: prizeId,
      name: prizeName
    };

    selectedWinners.push({ winner, prize });
    updateWinnersUI();
  }

  pendingPresentationPayload = null;
  animateWheelToPrize(prizeIndex, winnerName, `<span class="text-gradient">${winnerName}</span>`, false);
}

async function loadData() {
  try {
    const [partRes, prizeRes] = await Promise.all([
      fetch(API_PARTICIPANTS),
      fetch(API_PRIZES)
    ]);

    if (!partRes.ok || !prizeRes.ok) {
      throw new Error("Unable to load raffle data");
    }

    const fetchedParticipants = await partRes.json();
    const fetchedPrizes = await prizeRes.json();

    if (!Array.isArray(fetchedParticipants) || !Array.isArray(fetchedPrizes)) {
      throw new Error("Raffle data has an invalid format");
    }

    participants = fetchedParticipants;
    prizes = fetchedPrizes;

    if (prizeCountBadge) {
      prizeCountBadge.innerHTML = `<i data-lucide="gift" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px"></i>${prizes.length} prizes | ${participants.length} participants`;
      if (window.lucide) lucide.createIcons();
    }

    updateRaffleLoop();
    updateButtonState();

    if (numWinnersInput && numWinnersInput.max !== undefined) {
      const maxPicks = Math.min(participants.length, prizes.length);
      if (maxPicks > 0) {
        numWinnersInput.max = maxPicks;
      }
    }

    if (PRESENTATION_MODE && pendingPresentationPayload) {
      applyPresentationSpin(pendingPresentationPayload);
    }

    drawWheel();
  } catch (error) {
    if (prizeCountBadge) {
      prizeCountBadge.textContent = prizes.length ? `${prizes.length} prizes | refresh unavailable` : "Unable to load prizes";
    }
    if (raffleLoop && !participants.length) {
      raffleLoop.textContent = "Unable to load participants. Please refresh.";
    }
    updateButtonState();
    drawWheel();
  }
}

function updateButtonState() {
  const availableParticipants = participants.filter((p) => !selectedWinners.some((w) => w.winner.id === p.id));
  const availablePrizes = prizes.filter((pr) => !selectedWinners.some((w) => w.prize.id === pr.id));

  if (spinButton) {
    spinButton.disabled = availableParticipants.length === 0 || availablePrizes.length === 0 || spinning;
  }
}

function drawWheel() {
  if (!ctx || !canvas) return;
  const availablePrizes = prizes.filter((pr) => !selectedWinners.some((w) => w.prize.id === pr.id));
  const wheelColors = ["#b9e8d2", "#b9dff2", "#f4d7a8", "#d7c8ed", "#f2c7c7", "#c9e3d8", "#c9d9ef", "#ead9b8"];

  if (!availablePrizes.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#eaf8f3";
    ctx.beginPath();
    ctx.arc(160, 160, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#516d66";
    ctx.font = "600 14px 'Poppins', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(prizes.length ? "All prizes won!" : "No prizes yet", 160, 165);
    return;
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = 150;
  const sliceAngle = (2 * Math.PI) / availablePrizes.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  availablePrizes.forEach((pr, index) => {
    const startAngle = index * sliceAngle;
    const endAngle = startAngle + sliceAngle;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = wheelColors[index % wheelColors.length];
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startAngle + sliceAngle / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#173f36";
    ctx.font = "600 12px 'Poppins', sans-serif";
    ctx.shadowColor = "rgba(255,255,255,0.7)";
    ctx.shadowBlur = 4;

    let label = pr.name;
    if (label.length > 15) label = label.substring(0, 15) + '...';
    ctx.fillText(label, radius - 20, 4);
    ctx.restore();
  });
}

function updateWinnersUI() {
  if (!winnersList) return;
  winnersList.innerHTML = "";

  selectedWinners.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-start";
    li.style.animation = "fadeIn 0.5s ease-in-out";
    li.innerHTML = `
      <div class="me-2 w-100">
        <div class="d-flex justify-content-between">
           <div class="fw-semibold text-primary">${index + 1}. <span class="text-primary">${item.winner.name}</span></div>
        </div>
        <div class="text-muted small mb-1">${item.winner.company_name} · ${item.winner.position}</div>
        <div class="badge bg-success-soft text-white text-wrap text-start mt-1" style="color: #ffffff !important;">
          <i data-lucide="gift" style="width:10px;height:10px;margin-right:2px;vertical-align:-1px; color: #ffffff;"></i>
          Won: ${item.prize.name}
        </div>
      </div>
    `;

    if (!document.getElementById("fadeInKeyframes")) {
      const style = document.createElement("style");
      style.id = "fadeInKeyframes";
      style.innerHTML = `@keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }`;
      document.head.appendChild(style);
    }

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

  const loopNames = participants.map((p) => p.name).filter(Boolean);
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
    const activeNames = participants.map((p) => p.name).filter(Boolean);
    if (!activeNames.length) return;
    raffleIndex = (raffleIndex + 1) % activeNames.length;
    raffleLoop.textContent = `Now showing: ${activeNames[raffleIndex]}`;
  }, 1400);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spinAndPickLocal() {
  if (spinning || !numWinnersInput || !spinButton || !wheelSelectedName || !clearButton) return;

  const requestedWinners = parseInt(numWinnersInput.value, 10) || 1;
  const numWinners = Math.max(1, Math.min(requestedWinners, participants.length, prizes.length));

  spinning = true;
  updateButtonState();
  clearButton.disabled = true;
  spinButton.classList.add("btn-spinning");

  for (let i = 0; i < numWinners; i++) {
    const availableParticipants = participants.filter((p) => !selectedWinners.some((w) => w.winner.id === p.id));
    const availablePrizes = prizes.filter((pr) => !selectedWinners.some((w) => w.prize.id === pr.id));

    if (availableParticipants.length === 0 || availablePrizes.length === 0) {
      wheelSelectedName.textContent = "Finished!";
      break;
    }

    wheelSelectedName.innerHTML = '<span class="text-primary">Spinning...</span>';

    const randomPrizeIndex = Math.floor(Math.random() * availablePrizes.length);
    const thisPrize = availablePrizes[randomPrizeIndex];
    const randomWinnerIndex = Math.floor(Math.random() * availableParticipants.length);
    const thisWinner = availableParticipants[randomWinnerIndex];

    const duration = 2500;
    const start = performance.now();

    await new Promise((resolve) => {
      function animate(now) {
        const elapsed = now - start;
        const t = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const randomExtraSpins = Math.PI * 8;
        const sliceAngle = (2 * Math.PI) / availablePrizes.length;
        const targetAngleForTop = -Math.PI / 2;
        const winnerCenterAngle = randomPrizeIndex * sliceAngle + sliceAngle / 2;
        const endRotation = randomExtraSpins + (targetAngleForTop - winnerCenterAngle);
        const currentAngle = eased * endRotation;

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(currentAngle);
        ctx.translate(-canvas.width / 2, -canvas.height / 2);
        drawWheel();
        ctx.restore();

        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      }

      requestAnimationFrame(animate);
    });

    selectedWinners.push({ winner: thisWinner, prize: thisPrize });
    publishSpinToPopup({ prizeId: thisPrize.id, winnerId: thisWinner.id, prizeName: thisPrize.name, winnerName: thisWinner.name });
    updateWinnersUI();
    wheelSelectedName.innerHTML = `<span class="text-gradient">${thisPrize.name}</span>`;

    if (i < numWinners - 1 && availableParticipants.length > 1 && availablePrizes.length > 1) {
      await sleep(1500);
    }
  }

  drawWheel();
  spinning = false;
  spinButton.classList.remove("btn-spinning");
  updateButtonState();
  clearButton.disabled = false;

  if (selectedWinners.length > 0) {
    wheelSelectedName.innerHTML = '<span class="text-gradient">Complete</span>';
  }
}

function clearPresentationState() {
  selectedWinners = [];
  updateWinnersUI();
  if (wheelSelectedName) {
    wheelSelectedName.textContent = "Ready";
  }
  if (raffleLoop) {
    raffleLoop.textContent = "Now showing: " + (participants[0]?.name || "Waiting for participants...");
  }
  drawWheel();
  updateButtonState();
}

function clearWinners() {
  selectedWinners = [];
  updateWinnersUI();
  wheelSelectedName.textContent = "Ready";
  if (raffleLoop) raffleLoop.textContent = "Now showing: " + (participants[0]?.name || "Waiting for participants...");
  drawWheel();
  updateButtonState();
  publishClearToPopup();
}

if (spinButton) spinButton.addEventListener("click", spinAndPickLocal);
if (clearButton) clearButton.addEventListener("click", clearWinners);

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
    } catch (error) {
      // Ignore malformed sync payloads.
    }
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

if (canvas) {
  loadData();
  setInterval(() => {
    if (!spinning) loadData();
  }, 5000);
}
