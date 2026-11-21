const sessionInfoEl = document.getElementById("sessionInfo");
const fileNameInputEl = document.getElementById("fileNameInput");
const exportBtnEl = document.getElementById("exportBtn");
const importBtnEl = document.getElementById("importBtn");
const importFileInputEl = document.getElementById("importFileInput");
const openReviewBtnEl = document.getElementById("openReviewBtn");
const deleteBtnEl = document.getElementById("deleteBtn");
const statusMsgEl = document.getElementById("statusMsg");
const searchInputEl = document.getElementById("searchInput");
const questionsContainerEl = document.getElementById("questionsContainer");
const apiKeyInputEl = document.getElementById("apiKeyInput");
const saveKeyBtnEl = document.getElementById("saveKeyBtn");
const BANK_KEY = "aiQuestionBank";

let currentSession = null;
let confirmDeleteTimer = null;
let awaitingDeleteConfirm = false;

const toggleBankBtnEl = document.getElementById("toggleBankBtn");
const clearBankBtnEl = document.getElementById("clearBankBtn");
const bankContainerEl = document.getElementById("bankContainer");

let localBank = {};
let isBankOpen = false;
let awaitingClearBank = false;
let clearBankTimer = null;

function normalizeBankId(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderBankList() {
  const entries = Object.values(localBank || {});
  if (toggleBankBtnEl) {
    toggleBankBtnEl.textContent = `Saved Bank (${entries.length})`;
  }

  if (!bankContainerEl) return;
  bankContainerEl.innerHTML = "";

  if (entries.length === 0) {
    bankContainerEl.innerHTML = '<div class="empty">No questions saved in local bank.</div>';
    return;
  }

  entries.forEach((doc) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "default";

    const topRow = document.createElement("div");
    topRow.className = "card-top";

    const qText = document.createElement("div");
    qText.className = "q-text";
    qText.style.marginBottom = "4px";
    qText.textContent = doc.question || doc.id || "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-delete";
    removeBtn.style.padding = "3px 8px";
    removeBtn.style.fontSize = "11px";
    removeBtn.textContent = "Delete";

    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const docId = doc.id || normalizeBankId(doc.question);
      chrome.storage.local.get({ [BANK_KEY]: {} }, (res) => {
        const updated = { ...(res[BANK_KEY] || {}) };
        delete updated[docId];
        chrome.storage.local.set({ [BANK_KEY]: updated }, () => {
          localBank = updated;
          renderBankList();
          showStatus("Question removed from bank.");
        });
      });
    });

    topRow.appendChild(qText);
    topRow.appendChild(removeBtn);
    card.appendChild(topRow);

    if (doc.aiReview?.correctOption) {
      const ansEl = document.createElement("div");
      ansEl.className = "q-answer";
      ansEl.textContent = `AI Answer: ${doc.aiReview.correctOption}`;
      card.appendChild(ansEl);
    }

    bankContainerEl.appendChild(card);
  });
}

toggleBankBtnEl?.addEventListener("click", () => {
  isBankOpen = !isBankOpen;
  if (bankContainerEl) {
    bankContainerEl.style.display = isBankOpen ? "flex" : "none";
  }
  if (isBankOpen) {
    chrome.storage.local.get({ [BANK_KEY]: {} }, (res) => {
      localBank = res[BANK_KEY] || {};
      renderBankList();
    });
  }
});

clearBankBtnEl?.addEventListener("click", () => {
  if (!awaitingClearBank) {
    awaitingClearBank = true;
    clearBankBtnEl.textContent = "Confirm Clear?";
    clearBankBtnEl.classList.remove("btn-delete");
    clearBankBtnEl.classList.add("btn-confirm");
    clearBankTimer = setTimeout(() => {
      awaitingClearBank = false;
      clearBankBtnEl.textContent = "Clear Bank";
      clearBankBtnEl.classList.remove("btn-confirm");
      clearBankBtnEl.classList.add("btn-delete");
    }, 4000);
    return;
  }

  clearTimeout(clearBankTimer);
  awaitingClearBank = false;
  clearBankBtnEl.textContent = "Clear Bank";
  clearBankBtnEl.classList.remove("btn-confirm");
  clearBankBtnEl.classList.add("btn-delete");

  chrome.storage.local.set({ [BANK_KEY]: {} }, () => {
    localBank = {};
    renderBankList();
    showStatus("Local bank cleared.");
  });
});

chrome.storage.local.get({ [BANK_KEY]: {} }, (res) => {
  localBank = res[BANK_KEY] || {};
  renderBankList();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[BANK_KEY]) {
    localBank = changes[BANK_KEY].newValue || {};
    renderBankList();
  }
});

chrome.storage.local.get({ geminiApiKey: "" }, (res) => {
  if (res.geminiApiKey && apiKeyInputEl) {
    apiKeyInputEl.value = res.geminiApiKey;
  }
});

saveKeyBtnEl?.addEventListener("click", () => {
  const token = (apiKeyInputEl?.value || "").trim();
  chrome.storage.local.set({ geminiApiKey: token }, () => {
    showStatus(token ? "API token saved." : "API token cleared.");
  });
});

function showStatus(message, isError = false) {
  statusMsgEl.textContent = message;
  statusMsgEl.style.color = isError ? "#f87171" : "#34d399";
  statusMsgEl.style.display = "block";
  setTimeout(() => {
    statusMsgEl.style.display = "none";
  }, 3000);
}

function getQuestionsArray(session) {
  if (!session) return [];

  if (Array.isArray(session.questionsList) && session.questionsList.length > 0) {
    return [...session.questionsList].sort((a, b) => {
      const numA = a.questionNumber ?? Number.MAX_SAFE_INTEGER;
      const numB = b.questionNumber ?? Number.MAX_SAFE_INTEGER;
      if (numA !== numB) return numA - numB;
      return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
    });
  }

  if (!session.questions || typeof session.questions !== "object") {
    return [];
  }

  return Object.values(session.questions).sort((a, b) => {
    const numA = a.questionNumber ?? Number.MAX_SAFE_INTEGER;
    const numB = b.questionNumber ?? Number.MAX_SAFE_INTEGER;
    if (numA !== numB) return numA - numB;
    return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
  });
}

function renderSession(session) {
  currentSession = session;
  const questions = getQuestionsArray(session);

  if (!session || questions.length === 0) {
    sessionInfoEl.textContent = "No recorded questions";
    questionsContainerEl.innerHTML =
      '<div class="empty">Start an exam or import a saved JSON file to review questions.</div>';
    return;
  }

  const reviewedCount = questions.filter((q) => typeof q.isCorrect === "boolean").length;
  const label = session.examTitle ? `${session.examTitle} (${session.sessionId})` : session.sessionId;
  sessionInfoEl.textContent = `Session: ${label} | Questions: ${questions.length} | Reviewed: ${reviewedCount}`;

  const query = searchInputEl.value.trim().toLowerCase();
  const filtered = query
    ? questions.filter(
        (item) =>
          (item.question || "").toLowerCase().includes(query) ||
          (item.selectedAnswer || "").toLowerCase().includes(query) ||
          (item.options || []).some((opt) => (opt.text || "").toLowerCase().includes(query))
      )
    : questions;

  if (filtered.length === 0) {
    questionsContainerEl.innerHTML = '<div class="empty">No matching questions found.</div>';
    return;
  }

  questionsContainerEl.innerHTML = "";

  filtered.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "card";

    const topRow = document.createElement("div");
    topRow.className = "card-top";

    const qNum = document.createElement("div");
    qNum.className = "q-num";
    qNum.textContent = item.questionNumber
      ? `Question ${item.questionNumber}${item.totalQuestions ? ` / ${item.totalQuestions}` : ""}`
      : `Question #${idx + 1}`;

    topRow.appendChild(qNum);

    if (item.isCorrect === true) {
      const badge = document.createElement("span");
      badge.className = "badge-correct";
      badge.textContent = "Correct";
      topRow.appendChild(badge);
    } else if (item.isCorrect === false) {
      const badge = document.createElement("span");
      badge.className = "badge-wrong";
      badge.textContent = "Wrong";
      topRow.appendChild(badge);
    }

    const qText = document.createElement("div");
    qText.className = "q-text";
    qText.textContent = item.question || "";

    const qAnswer = document.createElement("div");
    qAnswer.className = "q-answer";
    qAnswer.textContent = `Your answer: ${item.selectedAnswer || "Not answered"}`;

    const optionsBox = document.createElement("div");
    optionsBox.className = "options-box";

    const opts = Array.isArray(item.options) && item.options.length > 0 ? item.options : [];
    if (opts.length === 0) {
      const noOpts = document.createElement("div");
      noOpts.className = "option-item";
      noOpts.textContent = "No saved options for this question.";
      optionsBox.appendChild(noOpts);
    } else {
      opts.forEach((opt) => {
        const optEl = document.createElement("div");
        const isSelected =
          Boolean(item.selectedAnswer) &&
          opt.text &&
          opt.text.trim() === item.selectedAnswer.trim();

        optEl.className = isSelected ? "option-item is-selected" : "option-item";
        optEl.textContent = isSelected ? `✓ ${opt.text} (Your answer)` : opt.text;
        optionsBox.appendChild(optEl);
      });
    }

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Click to toggle all options";

    card.addEventListener("click", () => {
      card.classList.toggle("expanded");
    });

    card.appendChild(topRow);
    card.appendChild(qText);
    card.appendChild(qAnswer);
    card.appendChild(optionsBox);
    card.appendChild(hint);
    questionsContainerEl.appendChild(card);
  });
}

function loadSession() {
  chrome.storage.local.get({ mockExamSession: null }, (res) => {
    renderSession(res.mockExamSession);
  });
}

function normalizeImportedSession(rawData, fileName) {
  const baseName = (fileName || "").replace(/\.json$/i, "").trim();
  const questionsMap = {};

  if (rawData && rawData.questions && typeof rawData.questions === "object") {
    Object.entries(rawData.questions).forEach(([key, item]) => {
      const qText = item?.question || key;
      questionsMap[qText] = { ...item, question: qText };
    });
  } else if (rawData && Array.isArray(rawData.questionsList)) {
    rawData.questionsList.forEach((item, index) => {
      const qText = item?.question || `Question ${index + 1}`;
      questionsMap[qText] = { ...item, question: qText };
    });
  } else if (Array.isArray(rawData)) {
    rawData.forEach((item, index) => {
      const qText = item?.question || `Question ${index + 1}`;
      questionsMap[qText] = { ...item, question: qText };
    });
  }

  return {
    sessionId: rawData?.sessionId || `imported_${Date.now()}`,
    examTitle: rawData?.examTitle || baseName || "Imported Exam",
    startedAt: rawData?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewCompleted: true,
    questions: questionsMap
  };
}

exportBtnEl.addEventListener("click", () => {
  chrome.storage.local.get({ mockExamSession: null }, (res) => {
    if (!res.mockExamSession) {
      showStatus("No session data to export.", true);
      return;
    }

    const customName = fileNameInputEl.value.trim();
    const defaultName = res.mockExamSession.sessionId || "manara-mock-exam";
    const cleanName = (customName || defaultName).replace(/\.json$/i, "");

    const payload = {
      ...res.mockExamSession,
      examTitle: customName || res.mockExamSession.examTitle || cleanName,
      questionsList: getQuestionsArray(res.mockExamSession)
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cleanName}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${cleanName}.json`);
  });
});

importBtnEl.addEventListener("click", () => {
  importFileInputEl.value = "";
  importFileInputEl.click();
});

importFileInputEl.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(String(e.target?.result || "{}"));
      const importedSession = normalizeImportedSession(parsed, file.name);
      const count = Object.keys(importedSession.questions).length;

      if (count === 0) {
        showStatus("JSON file contains no valid questions.", true);
        return;
      }

      chrome.storage.local.set({ mockExamSession: importedSession }, () => {
        renderSession(importedSession);
        chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
      });
    } catch {
      showStatus("Invalid JSON file.", true);
    }
  };
  reader.readAsText(file);
});

openReviewBtnEl.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});

function resetDeleteButton() {
  awaitingDeleteConfirm = false;
  deleteBtnEl.textContent = "Delete Session";
  deleteBtnEl.classList.remove("btn-confirm");
  deleteBtnEl.classList.add("btn-delete");
  if (confirmDeleteTimer) {
    clearTimeout(confirmDeleteTimer);
    confirmDeleteTimer = null;
  }
}

deleteBtnEl.addEventListener("click", () => {
  if (!awaitingDeleteConfirm) {
    awaitingDeleteConfirm = true;
    deleteBtnEl.textContent = "Confirm Delete?";
    deleteBtnEl.classList.remove("btn-delete");
    deleteBtnEl.classList.add("btn-confirm");
    confirmDeleteTimer = setTimeout(resetDeleteButton, 4000);
    return;
  }

  resetDeleteButton();
  chrome.storage.local.remove("mockExamSession", () => {
    renderSession(null);
    showStatus("Session deleted.");
  });
});

searchInputEl.addEventListener("input", () => {
  renderSession(currentSession);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.mockExamSession) {
    renderSession(changes.mockExamSession.newValue || null);
  }
});

loadSession();