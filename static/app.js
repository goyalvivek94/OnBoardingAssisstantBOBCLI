// ── Global State ─────────────────────────────────────────────────────────────
let activeDifficulty = 'medium';
let documentsList = [];
let quizQuestions = [];
let selectedAnswers = {}; // questionIndex -> selectedOptionIndex (0-3)
let activeQuestionIndex = 0;
let bobCommand = '';
let bobLogs = '';

// ── DOM Elements ─────────────────────────────────────────────────────────────
const screens = {
    setup: document.getElementById('setup-screen'),
    loading: document.getElementById('loading-screen'),
    quiz: document.getElementById('quiz-screen'),
    results: document.getElementById('results-screen')
};

// ── Initialization ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    fetchDocuments();
});

// ── Document Indexing ────────────────────────────────────────────────────────

async function fetchDocuments() {
    const listContainer = document.getElementById('documents-list');
    try {
        const response = await fetch('/api/documents');
        if (!response.ok) throw new Error('Failed to fetch document metadata');
        
        const data = await response.json();
        documentsList = data.documents || [];
        
        if (documentsList.length === 0) {
            listContainer.innerHTML = `
                <div class="loading-inline" style="color: var(--accent-red);">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span>No policy documents (.md/.txt) found in ./data folder.</span>
                </div>
            `;
            return;
        }
        
        listContainer.innerHTML = '';
        documentsList.forEach(doc => {
            const sizeKB = (doc.size_bytes / 1024).toFixed(1);
            const item = document.createElement('div');
            item.className = 'document-item';
            item.innerHTML = `
                <div class="doc-info">
                    <i class="fa-regular fa-file-lines"></i>
                    <span class="doc-name" title="${doc.name}">${doc.name}</span>
                </div>
                <div class="doc-meta">
                    <span class="badge badge-size">${sizeKB} KB</span>
                    <span class="badge badge-chunks">${doc.chunks_count} chunks</span>
                </div>
            `;
            listContainer.appendChild(item);
        });
    } catch (error) {
        listContainer.innerHTML = `
            <div class="document-item" style="border:none;">
                <div class="doc-info" style="color: var(--text-secondary);">
                    <i class="fa-solid fa-cloud-arrow-down"></i>
                    <span class="doc-name">Static Mode (GitHub Pages)</span>
                </div>
                <div class="doc-meta">
                    <span class="badge badge-size">Pre-compiled</span>
                </div>
            </div>
        `;
    }
}

// ── Difficulty Selection ─────────────────────────────────────────────────────

function selectDifficulty(level) {
    activeDifficulty = level;
    document.querySelectorAll('.difficulty-box').forEach(box => {
        box.classList.remove('active');
    });
    const selectedBox = document.querySelector(`.difficulty-box.${level}`);
    if (selectedBox) {
        selectedBox.classList.add('active');
    }
}

// ── Quiz Generation & Terminal Simulation ────────────────────────────────────

function showScreen(screenId) {
    Object.keys(screens).forEach(key => {
        screens[key].classList.remove('active');
    });
    screens[screenId].classList.add('active');
}

async function startQuizGeneration() {
    showScreen('loading');
    
    const statusText = document.getElementById('loading-status');
    const commandText = document.getElementById('terminal-command');
    const outputPre = document.getElementById('terminal-output');
    
    statusText.textContent = "Scanning documents and constructing prompt context...";
    commandText.textContent = `bob --hide-intermediary-output --output-format json --chat-mode ask "[Prompt with 10 excerpts at ${activeDifficulty.toUpperCase()} difficulty]"`
    outputPre.textContent = `[system] Indexing document chunks...\n[system] Selected 10 random chunks across available files.\n[system] Launching IBM BOB CLI child process...\n[system] Waiting for BOB response...`;
    
    // Animate system messages while waiting
    let dots = 0;
    const waitingInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        statusText.textContent = `Calling IBM BOB CLI to generate questions${'.'.repeat(dots)}`;
    }, 500);

    try {
        const response = await fetch('/api/quiz/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ difficulty: activeDifficulty })
        });
        
        clearInterval(waitingInterval);
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to generate quiz');
        }
        
        quizQuestions = data.questions;
        bobCommand = data.bob_command;
        bobLogs = data.bob_logs;
        
        statusText.textContent = "Generation complete! Preparing quiz player...";
        commandText.textContent = bobCommand;
        
        // Print the real BOB logs into the terminal with typewriter effect
        typeTerminalLogs(bobLogs, () => {
            // Automatically start the quiz after logs complete printing (with a slight delay)
            setTimeout(() => {
                initializeQuizPlayer();
            }, 1000);
        });
        
    } catch (error) {
        // Fallback for static environments (e.g. GitHub Pages) where python server is absent
        console.warn('Backend API unavailable. Attempting static JSON fallback...', error);
        
        try {
            statusText.textContent = "API offline. Loading pre-generated static quiz data...";
            const staticResponse = await fetch(`static/quiz_data_${activeDifficulty}.json`);
            
            if (!staticResponse.ok) {
                throw new Error(`Failed to load static quiz: ${staticResponse.statusText}`);
            }
            
            clearInterval(waitingInterval);
            
            const staticQuestions = await staticResponse.json();
            quizQuestions = staticQuestions;
            bobCommand = `bob --hide-intermediary-output --output-format json --chat-mode ask < [static_build_trigger]`;
            bobLogs = `[system] Running in Static Deployment (GitHub Pages)\n[system] Loaded pre-compiled quiz questions for difficulty: ${activeDifficulty.toUpperCase()}\n[system] Generated by GitHub Actions workflow execution.`;
            
            statusText.textContent = "Loaded static quiz successfully! Starting player...";
            commandText.textContent = bobCommand;
            
            typeTerminalLogs(bobLogs, () => {
                setTimeout(() => {
                    initializeQuizPlayer();
                }, 1000);
            });
            
        } catch (fallbackError) {
            clearInterval(waitingInterval);
            statusText.textContent = "Quiz Generation Failed!";
            statusText.style.color = "var(--accent-red)";
            outputPre.textContent += `\n\n[FATAL ERROR] Both live API and static fallback failed.\nLive Error: ${error.message}\nStatic Error: ${fallbackError.message}`;
            
            // Add a Back Button to Setup Screen
            const errBackBtn = document.createElement('button');
            errBackBtn.className = "btn btn-secondary";
            errBackBtn.style.marginTop = "1rem";
            errBackBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Configurations';
            errBackBtn.onclick = () => {
                showScreen('setup');
                statusText.style.color = "var(--text-secondary)";
                errBackBtn.remove();
            };
            document.querySelector('.loading-container').appendChild(errBackBtn);
        }
    }
}

function typeTerminalLogs(logs, callback) {
    const outputEl = document.getElementById('terminal-output');
    const lines = logs.split('\n');
    outputEl.textContent = '';
    
    let lineIdx = 0;
    // Speed: prints a line every 30-70ms to represent fast execution output
    function printNextLine() {
        if (lineIdx < lines.length) {
            outputEl.textContent += lines[lineIdx] + '\n';
            outputEl.scrollTop = outputEl.scrollHeight;
            lineIdx++;
            
            const delay = Math.random() * 20 + 5;
            setTimeout(printNextLine, delay);
        } else {
            if (callback) callback();
        }
    }
    printNextLine();
}

// ── Quiz Player Logic ────────────────────────────────────────────────────────

function initializeQuizPlayer() {
    selectedAnswers = {};
    activeQuestionIndex = 0;
    showScreen('quiz');
    renderQuestion();
}

function renderQuestion() {
    const q = quizQuestions[activeQuestionIndex];
    
    // Progress details
    document.getElementById('quiz-progress-text').textContent = `Question ${activeQuestionIndex + 1} of 10`;
    document.getElementById('quiz-timer').textContent = `Difficulty: ${activeDifficulty.charAt(0).toUpperCase() + activeDifficulty.slice(1)}`;
    
    // Progress fill
    const percent = ((activeQuestionIndex + 1) / 10) * 100;
    document.getElementById('quiz-progress-fill').style.width = `${percent}%`;
    
    // Numbers and source
    document.getElementById('display-q-number').textContent = activeQuestionIndex + 1;
    document.getElementById('display-q-source').textContent = `Source excerpt: ${q.source_doc || 'Compliance Document'}`;
    document.getElementById('display-q-text').textContent = q.question;
    
    // Options
    const optionsContainer = document.getElementById('options-container');
    optionsContainer.innerHTML = '';
    
    q.options.forEach((optText, idx) => {
        const optionLetter = String.fromCharCode(65 + idx); // A, B, C, D
        const isSelected = selectedAnswers[activeQuestionIndex] === idx;
        
        const optionCard = document.createElement('div');
        optionCard.className = `option-card ${isSelected ? 'selected' : ''}`;
        optionCard.onclick = () => selectOption(idx);
        optionCard.innerHTML = `
            <span class="option-letter">${optionLetter}</span>
            <span class="option-text">${optText}</span>
        `;
        optionsContainer.appendChild(optionCard);
    });
    
    // Buttons state
    document.getElementById('btn-prev-question').disabled = (activeQuestionIndex === 0);
    
    const nextBtn = document.getElementById('btn-next-question');
    const hasSelected = selectedAnswers[activeQuestionIndex] !== undefined;
    nextBtn.disabled = !hasSelected;
    
    if (activeQuestionIndex === 9) {
        nextBtn.innerHTML = 'Submit Quiz <i class="fa-solid fa-paper-plane btn-icon" style="margin-left:0.5rem;margin-right:0;"></i>';
    } else {
        nextBtn.innerHTML = 'Next <i class="fa-solid fa-arrow-right" style="margin-left:0.5rem;"></i>';
    }
}

function selectOption(optionIndex) {
    selectedAnswers[activeQuestionIndex] = optionIndex;
    
    // Re-render current question to update visual styles
    renderQuestion();
}

function prevQuestion() {
    if (activeQuestionIndex > 0) {
        activeQuestionIndex--;
        renderQuestion();
    }
}

function nextQuestion() {
    if (activeQuestionIndex < 9) {
        activeQuestionIndex++;
        renderQuestion();
    } else {
        finishQuiz();
    }
}

// ── Results & Detailed Evaluation Review ─────────────────────────────────────

function finishQuiz() {
    showScreen('results');
    
    // Calculate Score
    let correctCount = 0;
    quizQuestions.forEach((q, idx) => {
        if (selectedAnswers[idx] === q.answer_index) {
            correctCount++;
        }
    });
    
    const scorePercent = (correctCount / 10) * 100;
    
    // Render score text
    document.getElementById('result-score-percent').textContent = `${scorePercent}%`;
    document.getElementById('result-score-fraction').textContent = `${correctCount} / 10 Correct`;
    
    // Animate radial progress circle
    const circleFill = document.getElementById('score-circle-fill');
    const totalCircumference = 2 * Math.PI * 50; // 314.16
    const offset = totalCircumference - (totalCircumference * scorePercent) / 100;
    circleFill.style.strokeDashoffset = offset;
    
    // Pass/Fail logic
    const badge = document.getElementById('result-badge');
    const badgeIcon = document.getElementById('result-badge-icon');
    const badgeText = document.getElementById('result-badge-text');
    
    if (scorePercent >= 60) {
        badge.className = 'result-badge pass';
        badgeIcon.className = 'fa-solid fa-circle-check';
        badgeText.textContent = 'PASSED';
        circleFill.style.stroke = 'var(--accent-green)';
    } else {
        badge.className = 'result-badge fail';
        badgeIcon.className = 'fa-solid fa-triangle-exclamation';
        badgeText.textContent = 'FAILED';
        circleFill.style.stroke = 'var(--accent-red)';
    }
    
    // Generate detailed review cards
    renderDetailedReview();
}

function renderDetailedReview() {
    const reviewContainer = document.getElementById('review-list');
    reviewContainer.innerHTML = '';
    
    quizQuestions.forEach((q, idx) => {
        const userChoice = selectedAnswers[idx];
        const correctChoice = q.answer_index;
        const isCorrect = userChoice === correctChoice;
        
        const reviewItem = document.createElement('div');
        reviewItem.className = 'review-item';
        
        reviewItem.innerHTML = `
            <div class="review-item-header" onclick="toggleReviewItem(this)">
                <div class="review-title-section">
                    <span class="status-indicator ${isCorrect ? 'correct' : 'incorrect'}">
                        <i class="fa-solid ${isCorrect ? 'fa-check' : 'fa-xmark'}"></i>
                    </span>
                    <div>
                        <div class="review-q-text">${q.question}</div>
                        <div class="review-doc-badge">Source: ${q.source_doc || 'Compliance Document'}</div>
                    </div>
                </div>
                <i class="fa-solid fa-chevron-down review-toggle-icon"></i>
            </div>
            <div class="review-item-details">
                <div class="review-options-list">
                    ${q.options.map((opt, optIdx) => {
                        let optClass = '';
                        let suffixIcon = '';
                        if (optIdx === correctChoice) {
                            optClass = 'correct-choice';
                            suffixIcon = '<i class="fa-solid fa-circle-check" style="margin-left:auto;color:var(--accent-green);"></i>';
                        } else if (optIdx === userChoice && !isCorrect) {
                            optClass = 'selected-wrong';
                            suffixIcon = '<i class="fa-solid fa-circle-xmark" style="margin-left:auto;color:var(--accent-red);"></i>';
                        }
                        return `
                            <div class="review-option ${optClass}">
                                <span class="option-letter">${String.fromCharCode(65 + optIdx)}</span>
                                <span class="option-text">${opt}</span>
                                ${suffixIcon}
                            </div>
                        `;
                    }).join('')}
                </div>
                <div class="review-explanation">
                    <strong>Explanation:</strong> ${q.explanation || 'No explanation provided.'}
                </div>
            </div>
        `;
        
        reviewContainer.appendChild(reviewItem);
    });
}

function toggleReviewItem(headerElement) {
    const parent = headerElement.parentElement;
    parent.classList.toggle('expanded');
}

// ── Retry & Return Actions ───────────────────────────────────────────────────

function retryQuiz() {
    // Retake with same difficulty
    startQuizGeneration();
}

function goToDashboard() {
    showScreen('setup');
    // Refresh document list in case files changed
    fetchDocuments();
}
