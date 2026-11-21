// Normalize whitespace so question matching across exam and review screens stays consistent
function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// Extract current question number if rendered (e.g. "Question 1/65")
function extractQuestionNumber() {
  const candidates = document.querySelectorAll("div, span, p");
  for (const el of candidates) {
    if (el.children.length === 0) {
      const txt = normalizeText(el.textContent);
      const match = txt.match(/Question\s+(\d+)\s*\/\s*(\d+)/i);
      if (match) {
        return {
          current: Number(match[1]),
          total: Number(match[2])
        };
      }
    }
  }
  return null;
}

// Read currently rendered exam question, all options, and selected answer
function scrapeCurrentQuestionState() {
  const questionEl = document.querySelector(".prose");
  const questionText = normalizeText(questionEl?.innerText || questionEl?.textContent);
  if (!questionText) return null;

  const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
  if (radios.length === 0) return null;

  const options = radios.map((radio, index) => {
    const label =
      (radio.id && document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)) ||
      radio.closest("label");
    const labelText = normalizeText(
      label?.innerText || label?.textContent || radio.value || `Option ${index + 1}`
    );
    return {
      inputId: radio.id || null,
      text: labelText,
      checked: Boolean(radio.checked)
    };
  });

  const selected = options.find((opt) => opt.checked) || null;
  const qNum = extractQuestionNumber();

  return {
    questionNumber: qNum?.current ?? null,
    totalQuestions: qNum?.total ?? null,
    question: questionText,
    options: options.map(({ inputId, text }) => ({ inputId, text })),
    selectedAnswer: selected ? selected.text : null,
    selectedInputId: selected ? selected.inputId : null,
    updatedAt: new Date().toISOString()
  };
}

// Save or update a question entry inside mockExamSession
function saveQuestionToStorage(state) {
  if (!state || !state.question) return;

  chrome.storage.local.get({ mockExamSession: null }, (res) => {
    const now = new Date().toISOString();
    const session = res.mockExamSession || {
      sessionId: `attempt_${Date.now()}`,
      startedAt: now,
      updatedAt: now,
      reviewCompleted: false,
      questions: {}
    };

    const key = state.question;
    const prev = session.questions[key] || {};

    // Preserve previously captured options if current scrape has none
    const mergedOptions =
      state.options && state.options.length > 0 ? state.options : prev.options || [];

    // Preserve previously captured selectedAnswer if current scrape has none
    const currentSelected = state.selectedAnswer ?? prev.selectedAnswer ?? null;

    session.questions[key] = {
      ...prev,
      ...state,
      options: mergedOptions,
      selectedAnswer: currentSelected,
      firstSelectedAnswer: prev.firstSelectedAnswer ?? currentSelected,
      answerHistory: [
        ...(prev.answerHistory || []),
        ...(currentSelected && prev.selectedAnswer !== currentSelected
          ? [{ answer: currentSelected, at: state.updatedAt }]
          : [])
      ]
    };

    session.updatedAt = now;
    chrome.storage.local.set({ mockExamSession: session });
  });
}

// Parse review counter like "1/65 Reviewed"
function parseReviewedCounter() {
  const candidates = document.querySelectorAll("span, div, p");
  for (const el of candidates) {
    if (el.children.length === 0) {
      const txt = normalizeText(el.textContent);
      const match = txt.match(/(\d+)\s*\/\s*(\d+)\s*Reviewed/i);
      if (match) {
        return {
          current: Number(match[1]),
          total: Number(match[2])
        };
      }
    }
  }
  return null;
}

// Scrape current card on the results/review screen
function scrapeReviewCard() {
  const nextBtn = document.getElementById("quiz-summary-next-question");
  const card = document.querySelector(".border-quiz-results-border");
  if (!nextBtn && !card) return null;

  const qEl = card ? card.querySelector("p") : null;
  const questionText = normalizeText(qEl?.innerText || qEl?.textContent);
  if (!questionText) return null;

  const cardText = normalizeText(card?.innerText || card?.textContent || "");
  const hasFailIcon = Boolean(card?.querySelector(".text-quiz-fail-text"));
  const hasSuccessIcon = Boolean(card?.querySelector(".text-quiz-success"));

  let isCorrect = null;
  if (hasFailIcon || /\b(wrong|incorrect)\b/i.test(cardText)) {
    isCorrect = false;
  } else if (hasSuccessIcon || /\bcorrect answer\b/i.test(cardText)) {
    isCorrect = true;
  }

  const counter = parseReviewedCounter();
  const isNextDisabled =
    !nextBtn ||
    nextBtn.disabled ||
    nextBtn.getAttribute("aria-disabled") === "true" ||
    nextBtn.classList.contains("cursor-not-allowed");

  const isLastQuestion =
    isNextDisabled || (counter && counter.current >= counter.total);

  return {
    question: questionText,
    reviewNumber: counter?.current ?? null,
    totalReviewed: counter?.total ?? null,
    isCorrect,
    statusLabel: isCorrect === true ? "Correct" : isCorrect === false ? "Incorrect" : "Unknown",
    isLastQuestion
  };
}

// Match by normalized question text first, then fallback to question number
function saveReviewResult(reviewItem) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ mockExamSession: null }, (res) => {
      const now = new Date().toISOString();
      const session = res.mockExamSession || {
        sessionId: `attempt_${Date.now()}`,
        startedAt: now,
        updatedAt: now,
        reviewCompleted: false,
        questions: {}
      };

      let targetKey = reviewItem.question;

      if (!session.questions[targetKey] && reviewItem.reviewNumber != null) {
        const matchedEntry = Object.entries(session.questions).find(
          ([, q]) => q.questionNumber === reviewItem.reviewNumber
        );
        if (matchedEntry) {
          targetKey = matchedEntry[0];
        }
      }

      const prev = session.questions[targetKey] || {
        question: reviewItem.question,
        options: [],
        selectedAnswer: null
      };

      session.questions[targetKey] = {
        ...prev,
        questionNumber: prev.questionNumber ?? reviewItem.reviewNumber,
        totalQuestions: prev.totalQuestions ?? reviewItem.totalReviewed,
        isCorrect: reviewItem.isCorrect,
        statusLabel: reviewItem.statusLabel,
        reviewedAt: now
      };

      session.updatedAt = now;
      chrome.storage.local.set({ mockExamSession: session }, resolve);
    });
  });
}

let isAutoScanningReview = false;
let hasOpenedReportForSession = null;

function openFullReviewPage(sessionId) {
  if (!sessionId || hasOpenedReportForSession === sessionId) return;
  hasOpenedReportForSession = sessionId;

  chrome.storage.local.get({ mockExamSession: null }, (res) => {
    if (!res.mockExamSession) return;
    const updatedSession = {
      ...res.mockExamSession,
      reviewCompleted: true,
      reviewCompletedAt: new Date().toISOString()
    };

    chrome.storage.local.set({ mockExamSession: updatedSession }, () => {
      const url = chrome.runtime.getURL("review.html");
      window.open(url, "_blank");
    });
  });
}

// Automatically step through all reviewed questions and record correctness
async function runAutoReviewScanner() {
  if (isAutoScanningReview) return;
  const nextBtn = document.getElementById("quiz-summary-next-question");
  if (!nextBtn) return;

  isAutoScanningReview = true;

  try {
    let safetyCounter = 0;
    while (safetyCounter < 300) {
      safetyCounter += 1;

      const currentNextBtn = document.getElementById("quiz-summary-next-question");
      const reviewData = scrapeReviewCard();

      if (reviewData) {
        await saveReviewResult(reviewData);
      }

      const stillHasNext =
        currentNextBtn &&
        !currentNextBtn.disabled &&
        currentNextBtn.getAttribute("aria-disabled") !== "true" &&
        !currentNextBtn.classList.contains("cursor-not-allowed") &&
        !reviewData?.isLastQuestion;

      if (!stillHasNext) {
        break;
      }

      const prevQuestionText = reviewData?.question || "";
      currentNextBtn.click();

      // Wait until the DOM updates to the next question card
      await new Promise((resolve) => {
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += 80;
          const nextCard = scrapeReviewCard();
          const changed = nextCard && nextCard.question !== prevQuestionText;
          if (changed || elapsed >= 1200) {
            clearInterval(interval);
            resolve();
          }
        }, 80);
      });

      await new Promise((r) => setTimeout(r, 120));
    }

    chrome.storage.local.get({ mockExamSession: null }, (res) => {
      if (res.mockExamSession?.sessionId) {
        openFullReviewPage(res.mockExamSession.sessionId);
      }
    });
  } finally {
    isAutoScanningReview = false;
  }
}

// Listen for answer selection changes during the exam
document.addEventListener("change", (event) => {
  const radio = event.target?.closest?.('input[type="radio"]');
  if (!radio) return;

  setTimeout(() => {
    const state = scrapeCurrentQuestionState();
    if (state) {
      saveQuestionToStorage(state);
    }
  }, 50);
});

// Observe DOM for SPA question navigation and transition into review mode
const observer = new MutationObserver(() => {
  const state = scrapeCurrentQuestionState();
  if (state && state.selectedAnswer) {
    saveQuestionToStorage(state);
  }

  if (document.getElementById("quiz-summary-next-question") && !isAutoScanningReview) {
    chrome.storage.local.get({ mockExamSession: null }, (res) => {
      const sid = res.mockExamSession?.sessionId;
      if (sid && hasOpenedReportForSession !== sid) {
        runAutoReviewScanner();
      }
    });
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Run immediately on load in case the user is already on the summary screen
setTimeout(() => {
  const state = scrapeCurrentQuestionState();
  if (state && state.selectedAnswer) {
    saveQuestionToStorage(state);
  }
  if (document.getElementById("quiz-summary-next-question")) {
    runAutoReviewScanner();
  }
}, 400);