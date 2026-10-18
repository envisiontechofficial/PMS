# Pharmacy Manager (FastAPI + Next.js/TypeScript)
1. Google Cloud Console: create OAuth Web client ID; add http://localhost:3000 as authorized JS origin.
2. Backend: cd backend; cp .env.example .env (fill); pip install -r requirements.txt; uvicorn main:app --port 8000
3. Frontend: cd frontend; cp .env.example .env.local (fill); npm i; npm run dev
4. First Gmail to sign in (or FIRST_ADMIN_EMAIL) becomes admin; others wait for approval, then admin assigns roles.
5. Drive backup: create a service account, enable Drive API, share a Drive folder with it, set GDRIVE_* in .env.
Production: HTTPS, COOKIE_SECURE=true, same-site domains, Postgres, encrypted disk, scheduled backups.
