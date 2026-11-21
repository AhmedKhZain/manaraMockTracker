const pageTitleEl = document.getElementById("pageTitle");
const sessionMetaEl = document.getElementById("sessionMeta");
const statsBoxEl = document.getElementById("statsBox");
const cardsContainerEl = document.getElementById("cardsContainer");
const searchBoxEl = document.getElementById("searchBox");
const exportJsonBtnEl = document.getElementById("exportJsonBtn");
const importJsonBtnEl = document.getElementById("importJsonBtn");
const reviewFileInputEl = document.getElementById("reviewFileInput");
const reviewApiKeyInputEl = document.getElementById("reviewApiKeyInput");
const saveReviewTokenBtnEl = document.getElementById("saveReviewTokenBtn");
const filterBtns = document.querySelectorAll(".filter-btn");

const GEMINI_MODEL = "gemini-3.8-flash";
const BANK_STORAGE_KEY = "aiQuestionBank";

let sessionData = null;
let questionBank = {};
let geminiApiKey = "";
let activeFilter = "all";

// Deterministic normalization so identical questions across exams map to the same document ID
function normalizeQuestionId(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSortedQuestions(session) {
  if (!session) return [];

  if (Array.isArray(session.questionsList) && session.questionsList.length > 0) {
    return [...session.questionsList].sort((a, b) => {
      const numA = a.questionNumber ?? Number.MAX_SAFE_INTEGER;
      const numB = b.questionNumber ?? Number.MAX_SAFE_INTEGER;
      if (numA !== numB) return numA - numB;
      return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
    });
  }

  if (!session.questions || typeof session.questions !== "object") return [];

  return Object.values(session.questions).sort((a, b) => {
    const numA = a.questionNumber ?? Number.MAX_SAFE_INTEGER;
    const numB = b.questionNumber ?? Number.MAX_SAFE_INTEGER;
    if (numA !== numB) return numA - numB;
    return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
  });
}

// Hydrate current exam session questions from the local NoSQL-like question bank if already saved
function hydrateSessionFromBank(session, bank) {
  if (!session || !session.questions || !bank) return { session, changed: false };

  let changed = false;
  const updatedQuestions = { ...session.questions };

  for (const [key, qItem] of Object.entries(updatedQuestions)) {
    const qText = qItem?.question || key;
    const normId = normalizeQuestionId(qText);
    const bankDoc = bank[normId];

    if (bankDoc && bankDoc.aiReview && !qItem.aiReview) {
      updatedQuestions[key] = {
        ...qItem,
        normalizedId: normId,
        aiReview: bankDoc.aiReview,
        fromLocalBank: true
      };
      changed = true;
    } else if (!qItem.normalizedId && normId) {
      updatedQuestions[key] = {
        ...qItem,
        normalizedId: normId
      };
    }
  }

  return {
    session: {
      ...session,
      questions: updatedQuestions
    },
    changed
  };
}

function upsertQuestionInBank(questionItem, aiReviewObj) {
  return new Promise((resolve) => {
    const normId = normalizeQuestionId(questionItem.question);
    if (!normId || !aiReviewObj) {
      resolve();
      return;
    }

    chrome.storage.local.get({ [BANK_STORAGE_KEY]: {} }, (res) => {
      const bank = res[BANK_STORAGE_KEY] || {};
      bank[normId] = {
        id: normId,
        question: questionItem.question,
        options: questionItem.options || [],
        aiReview: aiReviewObj,
        savedAt: new Date().toISOString()
      };

      chrome.storage.local.set({ [BANK_STORAGE_KEY]: bank }, () => {
        questionBank = bank;
        resolve();
      });
    });
  });
}

function removeQuestionFromBank(questionText) {
  return new Promise((resolve) => {
    const normId = normalizeQuestionId(questionText);
    if (!normId) {
      resolve();
      return;
    }

    chrome.storage.local.get({ [BANK_STORAGE_KEY]: {} }, (res) => {
      const bank = res[BANK_STORAGE_KEY] || {};
      if (bank[normId]) {
        delete bank[normId];
      }

      chrome.storage.local.set({ [BANK_STORAGE_KEY]: bank }, () => {
        questionBank = bank;
        resolve();
      });
    });
  });
}

function saveQuestionAiReview(questionText, aiReviewObj, saveToBank = true) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ mockExamSession: null }, async (res) => {
      if (!res.mockExamSession || !res.mockExamSession.questions) {
        resolve();
        return;
      }

      const session = res.mockExamSession;
      const entry = session.questions[questionText];
      if (!entry) {
        resolve();
        return;
      }

      const normId = normalizeQuestionId(questionText);
      const updatedEntry = {
        ...entry,
        normalizedId: normId,
        aiReview: aiReviewObj,
        savedInBank: saveToBank ? true : Boolean(entry.savedInBank),
        updatedAt: new Date().toISOString()
      };

      session.questions[questionText] = updatedEntry;
      session.updatedAt = new Date().toISOString();

      if (saveToBank) {
        await upsertQuestionInBank(updatedEntry, aiReviewObj);
      }

      chrome.storage.local.set({ mockExamSession: session }, () => {
        sessionData = session;
        resolve();
      });
    });
  });
}

async function askAiForQuestion(questionItem, buttonEl, aiBoxContainerEl, autoSaveToBank = true) {
  const token = (reviewApiKeyInputEl?.value || geminiApiKey || "").trim();
  if (!token) {
    aiBoxContainerEl.innerHTML = '<div class="ai-error">Please enter and save your Gemini API token first.</div>';
    return;
  }

  buttonEl.disabled = true;
  buttonEl.textContent = "Asking AI...";

  const optionsText = (questionItem.options || [])
    .map((o, idx) => `${idx + 1}. ${o.text}`)
    .join("\n");

  const prompt = [
    "Answer concisely and directly with no filler.",
    "Return ONLY valid JSON matching this schema:",
    '{"correctOption":"exact option text","explanation":"concise reason why the correct answer is right","otherOptionsNote":"brief note on why the user answer or other options differ"}',
    "",
    `Question: ${questionItem.question}`,
    `Options:\n${optionsText || "N/A"}`,
    `User Answer: ${questionItem.selectedAnswer || "Not answered"}`,
    `Result Status: ${questionItem.isCorrect === true ? "Correct" : questionItem.isCorrect === false ? "Wrong" : "Unknown"}`
  ].join("\n");

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(token)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 180)}`);
    }

    const data = await response.json();
    const rawCandidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawCandidateText);

    const aiReviewObj = {
      correctOption: parsed.correctOption || "",
      explanation: parsed.explanation || "",
      otherOptionsNote: parsed.otherOptionsNote || "",
      answeredAt: new Date().toISOString()
    };

    await saveQuestionAiReview(questionItem.question, aiReviewObj, autoSaveToBank);
    renderReport();
  } catch (err) {
    aiBoxContainerEl.innerHTML = `<div class="ai-error">AI request failed: ${err.message}</div>`;
  } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = "Ask AI";
  }
}

function buildAiReviewBox(aiReview, isInBank) {
  const box = document.createElement("div");
  box.className = "ai-box";

  const title = document.createElement("div");
  title.className = "ai-title";
  title.textContent = isInBank ? "AI Review (Saved in Local Bank)" : "AI Review";
  box.appendChild(title);

  if (aiReview.correctOption) {
    const correctRow = document.createElement("div");
    correctRow.className = "ai-row";
    const strong = document.createElement("strong");
    strong.textContent = "Correct Option: ";
    correctRow.appendChild(strong);
    correctRow.appendChild(document.createTextNode(aiReview.correctOption));
    box.appendChild(correctRow);
  }

  if (aiReview.explanation) {
    const expRow = document.createElement("div");
    expRow.className = "ai-row";
    const strong = document.createElement("strong");
    strong.textContent = "Explanation: ";
    expRow.appendChild(strong);
    expRow.appendChild(document.createTextNode(aiReview.explanation));
    box.appendChild(expRow);
  }

  if (aiReview.otherOptionsNote) {
    const noteRow = document.createElement("div");
    noteRow.className = "ai-row";
    const strong = document.createElement("strong");
    strong.textContent = "Answer Comparison: ";
    noteRow.appendChild(strong);
    noteRow.appendChild(document.createTextNode(aiReview.otherOptionsNote));
    box.appendChild(noteRow);
  }

  return box;
}

function renderReport() {
  const allQuestions = getSortedQuestions(sessionData);

  if (!sessionData || allQuestions.length === 0) {
    pageTitleEl.textContent = "Exam Review Report";
    sessionMetaEl.textContent = "No session data available.";
    statsBoxEl.innerHTML = "";
    cardsContainerEl.innerHTML = '<div class="empty">No recorded questions found. Import a JSON file or complete an exam.</div>';
    return;
  }

  const correctCount = allQuestions.filter((q) => q.isCorrect === true).length;
  const wrongCount = allQuestions.filter((q) => q.isCorrect === false).length;
  const bankCount = Object.keys(questionBank || {}).length;

  pageTitleEl.textContent = sessionData.examTitle ? `Exam Review: ${sessionData.examTitle}` : "Exam Review Report";
  sessionMetaEl.textContent = `Session ID: ${sessionData.sessionId} | Local Bank Docs: ${bankCount}`;
  statsBoxEl.innerHTML = `
    <span class="stat-pill">Total: ${allQuestions.length}</span>
    <span class="stat-pill stat-correct">Correct: ${correctCount}</span>
    <span class="stat-pill stat-wrong">Wrong: ${wrongCount}</span>
  `;

  const searchTerm = searchBoxEl.value.trim().toLowerCase();

  const filtered = allQuestions.filter((q) => {
    if (activeFilter === "correct" && q.isCorrect !== true) return false;
    if (activeFilter === "wrong" && q.isCorrect !== false) return false;

    if (!searchTerm) return true;
    const inQuestion = (q.question || "").toLowerCase().includes(searchTerm);
    const inSelected = (q.selectedAnswer || "").toLowerCase().includes(searchTerm);
    const inOptions = (q.options || []).some((o) =>
      (o.text || "").toLowerCase().includes(searchTerm)
    );
    return inQuestion || inSelected || inOptions;
  });

  if (filtered.length === 0) {
    cardsContainerEl.innerHTML = '<div class="empty">No questions match the current filter or search.</div>';
    return;
  }

  cardsContainerEl.innerHTML = "";

  filtered.forEach((q, i) => {
    const normId = normalizeQuestionId(q.question);
    const isInBank = Boolean(normId && questionBank[normId]);

    const card = document.createElement("div");
    card.className = `q-card ${q.isCorrect === true ? "correct" : q.isCorrect === false ? "wrong" : ""}`;

    const header = document.createElement("div");
    header.className = "q-header";

    const leftGroup = document.createElement("div");
    leftGroup.className = "q-header-left";

    const indexEl = document.createElement("div");
    indexEl.className = "q-index";
    indexEl.textContent = q.questionNumber
      ? `Question ${q.questionNumber}${q.totalQuestions ? ` / ${q.totalQuestions}` : ""}`
      : `Question #${i + 1}`;

    const statusEl = document.createElement("span");
    if (q.isCorrect === true) {
      statusEl.className = "status-tag status-correct";
      statusEl.textContent = "Correct";
    } else if (q.isCorrect === false) {
      statusEl.className = "status-tag status-wrong";
      statusEl.textContent = "Wrong";
    } else {
      statusEl.className = "status-tag status-unknown";
      statusEl.textContent = "Unreviewed";
    }

    leftGroup.appendChild(indexEl);
    leftGroup.appendChild(statusEl);

    const rightGroup = document.createElement("div");
    rightGroup.style.display = "flex";
    rightGroup.style.gap = "6px";

    const askBtn = document.createElement("button");
    askBtn.type = "button";
    askBtn.className = "ask-ai-btn";
    askBtn.textContent = q.aiReview ? "Re-ask AI" : "Ask AI";

    rightGroup.appendChild(askBtn);

    if (q.aiReview) {
      const bankBtn = document.createElement("button");
      bankBtn.type = "button";
      bankBtn.className = "filter-btn";
      bankBtn.style.padding = "6px 10px";
      bankBtn.style.fontSize = "12px";
      bankBtn.textContent = isInBank ? "Remove Bank" : "Save to Bank";

      bankBtn.addEventListener("click", async () => {
        if (isInBank) {
          await removeQuestionFromBank(q.question);
        } else {
          await upsertQuestionInBank(q, q.aiReview);
        }
        renderReport();
      });

      rightGroup.appendChild(bankBtn);
    }

    header.appendChild(leftGroup);
    header.appendChild(rightGroup);

    const bodyEl = document.createElement("div");
    bodyEl.className = "q-body";
    bodyEl.textContent = q.question || "";

    const optionsList = document.createElement("div");
    optionsList.className = "options-list";

    const options = Array.isArray(q.options) && q.options.length > 0 ? q.options : [];
    const selectedNormalized = (q.selectedAnswer || "").trim();

    if (options.length === 0) {
      const fallback = document.createElement("div");
      fallback.className = "opt user-picked-neutral";
      fallback.textContent = `Your answer: ${q.selectedAnswer || "Not answered"}`;
      optionsList.appendChild(fallback);
    } else {
      options.forEach((opt) => {
        const optText = (opt.text || "").trim();
        const isPicked = Boolean(selectedNormalized) && optText === selectedNormalized;

        const optEl = document.createElement("div");
        optEl.className = "opt";

        if (isPicked) {
          if (q.isCorrect === true) {
            optEl.classList.add("user-picked-correct");
            optEl.textContent = `✓ ${opt.text} — Your answer (Correct)`;
          } else if (q.isCorrect === false) {
            optEl.classList.add("user-picked-wrong");
            optEl.textContent = `✕ ${opt.text} — Your answer (Wrong)`;
          } else {
            optEl.classList.add("user-picked-neutral");
            optEl.textContent = `• ${opt.text} — Your answer`;
          }
        } else {
          optEl.textContent = opt.text;
        }

        optionsList.appendChild(optEl);
      });
    }

    const aiSlot = document.createElement("div");
    if (q.aiReview) {
      aiSlot.appendChild(buildAiReviewBox(q.aiReview, isInBank));
    }

    askBtn.addEventListener("click", () => {
      askAiForQuestion(q, askBtn, aiSlot, true);
    });

    card.appendChild(header);
    card.appendChild(bodyEl);
    card.appendChild(optionsList);
    card.appendChild(aiSlot);
    cardsContainerEl.appendChild(card);
  });
}

function parseImportedData(rawData, fileName) {
  const baseName = (fileName || "").replace(/\.json$/i, "").trim();
  const questionsMap = {};

  if (rawData && rawData.questions && typeof rawData.questions === "object") {
    Object.entries(rawData.questions).forEach(([key, item]) => {
      const qText = item?.question || key;
      questionsMap[qText] = {
        ...item,
        question: qText,
        normalizedId: normalizeQuestionId(qText)
      };
    });
  } else if (rawData && Array.isArray(rawData.questionsList)) {
    rawData.questionsList.forEach((item, index) => {
      const qText = item?.question || `Question ${index + 1}`;
      questionsMap[qText] = {
        ...item,
        question: qText,
        normalizedId: normalizeQuestionId(qText)
      };
    });
  } else if (Array.isArray(rawData)) {
    rawData.forEach((item, index) => {
      const qText = item?.question || `Question ${index + 1}`;
      questionsMap[qText] = {
        ...item,
        question: qText,
        normalizedId: normalizeQuestionId(qText)
      };
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

saveReviewTokenBtnEl?.addEventListener("click", () => {
  geminiApiKey = (reviewApiKeyInputEl?.value || "").trim();
  chrome.storage.local.set({ geminiApiKey });
});

exportJsonBtnEl.addEventListener("click", () => {
  if (!sessionData) return;
  const cleanName = (sessionData.examTitle || sessionData.sessionId || "manara-mock-exam").replace(/\.json$/i, "");
  const payload = {
    ...sessionData,
    questionsList: getSortedQuestions(sessionData)
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${cleanName}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importJsonBtnEl.addEventListener("click", () => {
  reviewFileInputEl.value = "";
  reviewFileInputEl.click();
});

reviewFileInputEl.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(String(e.target?.result || "{}"));
      const imported = parseImportedData(parsed, file.name);
      const { session: hydrated, changed } = hydrateSessionFromBank(imported, questionBank);
      const finalSession = changed ? hydrated : imported;

      chrome.storage.local.set({ mockExamSession: finalSession }, () => {
        sessionData = finalSession;
        renderReport();
      });
    } catch {
      alert("Invalid JSON file.");
    }
  };
  reader.readAsText(file);
});

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    renderReport();
  });
});

searchBoxEl.addEventListener("input", renderReport);

function initReviewPage() {
  chrome.storage.local.get(
    {
      mockExamSession: null,
      [BANK_STORAGE_KEY]: {},
      geminiApiKey: ""
    },
    (res) => {
      questionBank = res[BANK_STORAGE_KEY] || {};
      geminiApiKey = res.geminiApiKey || "";
      if (reviewApiKeyInputEl) {
        reviewApiKeyInputEl.value = geminiApiKey;
      }

      if (res.mockExamSession) {
        const { session: hydrated, changed } = hydrateSessionFromBank(res.mockExamSession, questionBank);
        sessionData = hydrated;
        if (changed) {
          chrome.storage.local.set({ mockExamSession: hydrated });
        }
      } else {
        sessionData = null;
      }

      renderReport();
    }
  );
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[BANK_STORAGE_KEY]) {
    questionBank = changes[BANK_STORAGE_KEY].newValue || {};
  }

  if (changes.mockExamSession) {
    sessionData = changes.mockExamSession.newValue || null;
  }

  if (changes.geminiApiKey) {
    geminiApiKey = changes.geminiApiKey.newValue || "";
    if (reviewApiKeyInputEl) {
      reviewApiKeyInputEl.value = geminiApiKey;
    }
  }

  if (changes.mockExamSession || changes[BANK_STORAGE_KEY]) {
    renderReport();
  }
});

initReviewPage();