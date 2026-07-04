import os
import re
import shutil
import subprocess
import json
import random
import sys
from langchain_text_splitters import RecursiveCharacterTextSplitter

# ── Config ────────────────────────────────────────────────────────────────────
DATA_DIR = "./data"
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150

# Locate the BOB CLI (handles Windows .cmd wrapper and Unix paths)
_BOB_CMD = shutil.which("bob.cmd") or shutil.which("bob")

def get_bob_command_path() -> str:
    if _BOB_CMD is None:
        raise FileNotFoundError("BOB CLI not found on PATH. Install it with: npm install -g @ibm/bob")
    return _BOB_CMD

# ── 1. Document scanning & chunking ───────────────────────────────────────────

def get_documents_info(data_dir: str = DATA_DIR) -> list[dict]:
    """Scan the data directory and return details about documents and their chunk counts."""
    if not os.path.exists(data_dir):
        return []
    
    files = [f for f in os.listdir(data_dir) if f.endswith((".md", ".txt"))]
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    
    doc_info = []
    for f in files:
        filepath = os.path.join(data_dir, f)
        size = os.path.getsize(filepath)
        with open(filepath, encoding="utf-8") as fh:
            text = fh.read()
        chunks = splitter.split_text(text)
        doc_info.append({
            "name": f,
            "size_bytes": size,
            "chunks_count": len(chunks)
        })
    return doc_info

def load_and_chunk_all_documents(data_dir: str = DATA_DIR) -> dict[str, list[str]]:
    """Load all markdown/text documents and split them into chunks."""
    if not os.path.exists(data_dir):
        return {}
    
    files = [f for f in os.listdir(data_dir) if f.endswith((".md", ".txt"))]
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    
    doc_to_chunks = {}
    for f in files:
        filepath = os.path.join(data_dir, f)
        with open(filepath, encoding="utf-8") as fh:
            text = fh.read()
        chunks = splitter.split_text(text)
        # Filter out very short chunks (e.g. empty lines or headers only)
        chunks = [c.strip() for c in chunks if len(c.strip()) > 50]
        if chunks:
            doc_to_chunks[f] = chunks
            
    return doc_to_chunks

# ── 2. Stratified / Round-Robin Chunk Selection ───────────────────────────────

def sample_diverse_chunks(doc_to_chunks: dict[str, list[str]], target_count: int = 10) -> list[dict]:
    """
    Select target_count chunks across all documents in a round-robin/stratified manner
    to ensure coverage of all documents, shuffling selection for quiz variety.
    """
    if not doc_to_chunks:
        raise ValueError("No document chunks available to sample from.")
        
    doc_names = sorted(doc_to_chunks.keys())
    # Create copies of lists and shuffle them for random selection
    shuffled_docs = {name: doc_to_chunks[name][:] for name in doc_names}
    for name in shuffled_docs:
        random.shuffle(shuffled_docs[name])
        
    selected_chunks = []
    doc_index = 0
    attempts = 0
    max_attempts = 1000
    
    while len(selected_chunks) < target_count and attempts < max_attempts:
        attempts += 1
        current_doc = doc_names[doc_index % len(doc_names)]
        if shuffled_docs[current_doc]:
            chunk_text = shuffled_docs[current_doc].pop(0)
            selected_chunks.append({
                "document": current_doc,
                "text": chunk_text
            })
        doc_index += 1
        
        # If all documents are empty, break
        if all(not shuffled_docs[name] for name in doc_names):
            break
            
    # Fallback: if we still have fewer than target_count chunks, fill with random choices (with replacement)
    all_chunks_flat = []
    for name in doc_names:
        for c in doc_to_chunks[name]:
            all_chunks_flat.append({"document": name, "text": c})
            
    while len(selected_chunks) < target_count and all_chunks_flat:
        selected_chunks.append(random.choice(all_chunks_flat))
        
    return selected_chunks

# ── 3. Prompt generation & BOB call ───────────────────────────────────────────

def build_prompt(selected_chunks: list[dict], difficulty: str) -> str:
    """Construct prompt for BOB to generate 10 questions in a strict JSON schema."""
    excerpts_str = ""
    for idx, item in enumerate(selected_chunks):
        excerpts_str += f"\n[Excerpt {idx + 1}] (From Document: {item['document']})\n{item['text']}\n"
        
    prompt = (
        f"TASK: Generate exactly 10 onboarding and compliance verification multiple-choice questions (MCQs).\n\n"
        f"DIFFICULTY LEVEL: {difficulty.upper()}\n"
        f"- EASY: straightforward fact retrieval from the text.\n"
        f"- MEDIUM: requires understanding and application of the requirements.\n"
        f"- HARD: scenario-based, testing edge cases and interpretation of strict rules.\n\n"
        f"INSTRUCTIONS:\n"
        f"1. Read the 10 policy excerpts below. Generate exactly 1 question for each excerpt (Question 1 for Excerpt 1, Question 2 for Excerpt 2, etc.).\n"
        f"2. Each question MUST be multiple-choice with exactly 4 options (array of 4 strings).\n"
        f"3. Specify the correct option index (0 for first, 1 for second, 2 for third, 3 for fourth).\n"
        f"4. Provide a brief explanation (1-2 sentences) of why that answer is correct, quoting or referring to the excerpt.\n"
        f"5. Base all questions strictly on the text provided. Do not assume or extrapolate beyond the text.\n"
        f"6. Output ONLY a valid JSON array of 10 objects. Do not add any conversational text, warnings, markdown blocks, or extra characters. The output must start with '[' and end with ']'.\n\n"
        f"EXCERPTS:\n"
        f"{excerpts_str}\n"
        f"EXPECTED JSON FORMAT:\n"
        f"[\n"
        f"  {{\n"
        f"    \"question\": \"...\",\n"
        f"    \"options\": [\"Option 0\", \"Option 1\", \"Option 2\", \"Option 3\"],\n"
        f"    \"answer_index\": 0,\n"
        f"    \"explanation\": \"...\",\n"
        f"    \"source_doc\": \"...\"\n"
        f"  }},\n"
        f"  ...\n"
        f"]\n\n"
        f"JSON OUTPUT:"
    )
    return prompt

def call_bob(prompt: str) -> tuple[str, str, str]:
    """
    Send prompt to BOB CLI via standard input (stdin) and return (clean_answer, raw_command, stdout_full).
    """
    bob_cmd = get_bob_command_path()
    
    cmd_args = [
        str(bob_cmd),
        "--accept-license",
        "--hide-intermediary-output",
        "--output-format", "json",
        "--chat-mode", "advanced",
    ]
    
    # Formulate command string for representation (using standard stdin redirection syntax)
    raw_command = " ".join(cmd_args) + " < [prompt_stdin]"
    
    result = subprocess.run(
        cmd_args,
        input=prompt,
        capture_output=True,
        text=True,
    )
    
    stdout = result.stdout
    stderr = result.stderr
    
    stdout_full = stdout
    if stderr:
        stdout_full = f"[stderr]\n{stderr}\n\n[stdout]\n{stdout}"
        
    stdout_clean = stdout.strip()
    
    # Find the JSON array inside the output
    # First, split off the trailing JSON stats block if it exists
    split_marker = stdout_clean.rfind('\n{')
    response_part = stdout_clean[:split_marker].strip() if split_marker != -1 else stdout_clean
    
    # Strip any git warnings or npm warning prefixes
    start_idx = response_part.find('[')
    end_idx = response_part.rfind(']')
    
    if start_idx == -1 or end_idx == -1 or end_idx < start_idx:
        # Let's check if the stats block itself contains the response or if there was an error
        raise ValueError(
            f"Failed to find JSON array in BOB output.\n"
            f"Raw stdout preview: {stdout_clean[:500]}..."
        )
        
    json_str = response_part[start_idx:end_idx + 1]
    
    # Strip any backticks/markdown block wrapping if present
    json_str = re.sub(r'^```json\s*', '', json_str)
    json_str = re.sub(r'\s*```$', '', json_str)
    
    return json_str, raw_command, stdout_full

def generate_quiz_questions(difficulty: str = "medium", data_dir: str = DATA_DIR) -> dict:
    """Master function to chunk, sample, call BOB, and return quiz JSON and execution info."""
    doc_to_chunks = load_and_chunk_all_documents(data_dir)
    selected_chunks = sample_diverse_chunks(doc_to_chunks, target_count=10)
    prompt = build_prompt(selected_chunks, difficulty)
    
    json_data, raw_command, stdout_full = call_bob(prompt)
    
    try:
        questions = json.loads(json_data)
        # Validate structure: must be a list of 10 items
        if not isinstance(questions, list):
            raise ValueError("Parsed JSON is not a list")
    except Exception as e:
        raise ValueError(f"Failed to parse or validate quiz JSON: {str(e)}\nRaw JSON string: {json_data}")
        
    return {
        "questions": questions,
        "bob_command": raw_command,
        "bob_logs": stdout_full
    }
