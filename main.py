import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import uvicorn

import onboarding_backend

app = FastAPI(
    title="IBM BOB Onboarding Quiz Assistant",
    description="Automated multi-document onboarding and interview question generator powered by IBM BOB CLI",
    version="1.0.0"
)

# Ensure templates and static directories exist
os.makedirs("templates", exist_ok=True)
os.makedirs("static", exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Configure templates
templates = Jinja2Templates(directory="templates")

class QuizRequest(BaseModel):
    difficulty: str = "medium"

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """Serve the main quiz UI."""
    return templates.TemplateResponse(request, "index.html", {})

@app.get("/api/documents")
async def get_documents():
    """Endpoint to list the available policy documents and their chunk stats."""
    try:
        docs = onboarding_backend.get_documents_info()
        return {"documents": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/quiz/generate")
async def generate_quiz(req: QuizRequest):
    """Endpoint to trigger the IBM BOB question generation workflow."""
    if req.difficulty not in ["easy", "medium", "hard"]:
        raise HTTPException(status_code=400, detail="Invalid difficulty. Choose 'easy', 'medium', or 'hard'.")
        
    try:
        quiz_data = onboarding_backend.generate_quiz_questions(difficulty=req.difficulty)
        return quiz_data
    except Exception as e:
        # Return 500 but still include standard structure with logs if available
        # so the UI can display the failure terminal output.
        error_msg = str(e)
        return JSONResponse(
            status_code=500,
            content={
                "error": error_msg,
                "bob_command": getattr(e, "bob_command", f"bob --hide-intermediary-output --output-format json --chat-mode advanced ..."),
                "bob_logs": getattr(e, "bob_logs", f"Execution error:\n{error_msg}")
            }
        )

if __name__ == "__main__":
    # Get port from env or default to 8000
    port = int(os.environ.get("PORT", 8000))
    print(f"Starting server on http://localhost:{port}")
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
