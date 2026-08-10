# BuildResume

> **An AI-powered resume builder that helps users create, customize, and improve professional resumes with an integrated AI assistant.**

BuildResume is a full-stack resume-building platform designed to simplify the process of creating professional, ATS-friendly resumes.

Instead of manually editing resume documents, users can enter their information through a structured form, select from multiple resume templates, customize the appearance and ordering of sections, and interact with an AI assistant for resume improvement suggestions.

---

## ✨ Features

### 📄 Resume Builder

* Create a complete resume using a structured form-based interface.
* Manage multiple resume sections including:

  * Personal Information
  * Professional Summary
  * Education
  * Skills
  * Projects
  * Work Experience
  * Achievements
  * Certifications
  * Languages
  * Extracurricular Activities
* All resume sections are optional except essential personal information.
* Add clickable links such as GitHub, LinkedIn, LeetCode, and portfolio URLs.
* Dynamically update the resume preview while editing.

### 🎨 Resume Templates

BuildResume provides multiple professionally designed templates.

Currently supported templates include:

* **ATS Classic**
* **Modern Blue**
* **Corporate**

The template system is designed using a centralized template registry so that additional templates can be added without rewriting the core resume-building logic.

### 🤖 AI Resume Assistant

BuildResume includes an integrated AI assistant that helps users improve their resumes.

The assistant can:

* Analyze resume content.
* Suggest improvements.
* Recommend better wording.
* Help improve professional summaries.
* Suggest changes to resume sections.
* Provide actionable resume recommendations.

The AI assistant is powered by the **Google Gemini API**.

### ✏️ Resume Formatting

Users can customize the appearance of their resume by modifying:

* Font size
* Font color
* Bold
* Italic
* Underline
* Line spacing
* Section formatting

Formatting is designed to work with individual resume content blocks rather than forcing users to edit the entire document.

### 🔀 Section Reordering

Users can change the order of resume sections according to their requirements.

For example:

```text
Education
Skills
Projects
Experience
```

can be reordered to:

```text
Experience
Projects
Skills
Education
```

This allows users to prioritize the information that is most relevant to a particular job.

### 🖥️ Interactive Three-Panel Interface

The application uses a resizable three-panel workspace:

```text
┌──────────────────┬──────────────────┬──────────────────┐
│                  │                  │                  │
│  Resume Preview  │   Resume Form    │  AI Assistant    │
│                  │                  │                  │
│                  │                  │                  │
└──────────────────┴──────────────────┴──────────────────┘
```

Users can simultaneously:

1. Enter resume information.
2. View the generated resume.
3. Interact with the AI assistant.

### 🔐 Authentication

BuildResume includes authentication and user verification functionality using:

* JWT-based authentication
* Email OTP verification
* Protected API endpoints
* User-specific resume data

### 💾 Persistent Data Storage

Resume and user information can be stored using:

* PostgreSQL
* SQLAlchemy ORM
* Alembic database migrations

The backend follows a structured database architecture to keep user and resume data organized.

### 🌓 User Experience

The application also includes productivity-oriented UI features such as:

* Collapsible panels
* Full-screen / Zen Mode preview
* Template selection
* Save and continue workflow
* Responsive resume editing interface

---

# 🏗️ System Architecture

BuildResume follows a client-server architecture.

```text
                    ┌─────────────────────┐
                    │       User          │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │     Frontend        │
                    │                     │
                    │ HTML / CSS / JS     │
                    │ Vanilla JavaScript  │
                    └──────────┬──────────┘
                               │
                         REST API
                               │
                               ▼
                    ┌─────────────────────┐
                    │      FastAPI        │
                    │      Backend        │
                    ├─────────────────────┤
                    │ Authentication      │
                    │ Resume APIs         │
                    │ AI Integration      │
                    │ Business Logic      │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
                 ▼                           ▼
        ┌─────────────────┐        ┌─────────────────┐
        │   PostgreSQL    │        │   Gemini API    │
        │    Database     │        │ AI Assistant    │
        └─────────────────┘        └─────────────────┘
```

---

# 🛠️ Tech Stack

## Frontend

* HTML5
* CSS3
* JavaScript
* Vanilla JavaScript
* Browser Local Storage
* REST APIs

## Backend

* Python
* FastAPI
* SQLAlchemy
* Alembic
* Pydantic
* JWT Authentication

## Database

* PostgreSQL
* JSONB

## AI

* Google Gemini API

## DevOps

* Docker
* Docker Compose

---

# 📁 Project Structure

```text
BuildResume/
│
├── frontend/
│   │
│   ├── index.html
│   ├── css/
│   ├── js/
│   │   ├── script.js
│   │   ├── templates.js
│   │   └── ...
│   │
│   └── assets/
│
├── backend/
│   │
│   └── app/
│       │
│       ├── main.py
│       │
│       ├── core/
│       │   └── config.py
│       │
│       ├── db/
│       │   └── session.py
│       │
│       ├── models/
│       │   ├── user.py
│       │   ├── resume.py
│       │   └── template.py
│       │
│       ├── schemas/
│       │   ├── user.py
│       │   ├── resume.py
│       │   └── ai.py
│       │
│       └── ...
│
├── alembic/
│
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── .env.example
└── README.md
```

> The exact directory structure may vary slightly depending on the current implementation.

---

# 🔄 Application Workflow

### 1. User Registration

The user creates an account using their email address.

```text
User
  │
  ▼
Enter Email
  │
  ▼
OTP Verification
  │
  ▼
Account Created
```

### 2. Resume Creation

After authentication, the user enters their resume information through the resume builder.

```text
Personal Information
        ↓
Professional Summary
        ↓
Education
        ↓
Skills
        ↓
Projects
        ↓
Experience
        ↓
Additional Sections
```

### 3. Template Selection

The user selects a preferred resume template.

The selected template is then applied to the resume preview.

### 4. AI Assistance

The user can interact with the AI assistant to receive suggestions for improving resume content.

```text
User Resume
     │
     ▼
AI Assistant
     │
     ▼
Analyze Content
     │
     ▼
Generate Suggestions
     │
     ▼
User Reviews Changes
```

### 5. Resume Customization

Users can:

* Reorder sections
* Modify formatting
* Change templates
* Edit content
* Preview changes in real time

---

# 🔑 Authentication Flow

BuildResume uses JWT-based authentication for protecting backend resources.

A simplified authentication flow is:

```text
User
 │
 ├── Register
 │
 ▼
Email OTP
 │
 ▼
OTP Verification
 │
 ▼
Authenticated User
 │
 ▼
JWT Token
 │
 ▼
Protected API Requests
```

JWT tokens are used to authenticate subsequent requests to protected API endpoints.

---

# 🗄️ Database

PostgreSQL is used as the primary database.

SQLAlchemy provides the ORM layer between the application and PostgreSQL.

Alembic is used to manage database schema migrations.

A simplified relationship can be represented as:

```text
User
 │
 └──────────► Resume
                │
                ├── Personal Information
                ├── Education
                ├── Skills
                ├── Projects
                ├── Experience
                └── Additional Sections
```

PostgreSQL's **JSONB** capabilities can be used for storing flexible resume section data while maintaining a structured relational database.

---

# 🧩 Design Approach

BuildResume was designed with modularity in mind.

### Frontend

The frontend separates:

* UI rendering
* Resume state
* Template management
* Formatting
* User interactions
* API communication

### Backend

The backend separates:

* API routes
* Database models
* Pydantic schemas
* Configuration
* Database sessions
* Business logic

This makes the application easier to maintain and extend.

---

# 🚀 Getting Started

## Prerequisites

Make sure you have the following installed:

* Python 3.10+
* PostgreSQL
* Git
* Docker *(optional but recommended)*

---

## 1. Clone the Repository

```bash
git clone https://github.com/Krishnasinghal78/BuildResume.git

cd BuildResume
```

---

## 2. Create a Virtual Environment

```bash
python -m venv venv
```

### Windows

```bash
venv\Scripts\activate
```

### Linux / macOS

```bash
source venv/bin/activate
```

---

## 3. Install Dependencies

```bash
pip install -r requirements.txt
```

---

## 4. Configure Environment Variables

Create a `.env` file based on `.env.example`.

Example:

```env
DATABASE_URL=postgresql://username:password@localhost:5432/buildresume

JWT_SECRET_KEY=your_secret_key

GEMINI_API_KEY=your_gemini_api_key

SMTP_EMAIL=your_email
SMTP_PASSWORD=your_email_password
```

> Never commit your `.env` file or API keys to GitHub.

---

## 5. Run Database Migrations

```bash
alembic upgrade head
```

---

## 6. Start the Backend

```bash
uvicorn backend.app.main:app --reload
```

The API will be available at:

```text
http://127.0.0.1:8000
```

FastAPI also provides interactive API documentation at:

```text
http://127.0.0.1:8000/docs
```

---

# 🐳 Running with Docker

BuildResume can also be containerized using Docker.

Build the containers:

```bash
docker compose build
```

Start the application:

```bash
docker compose up
```

To run in detached mode:

```bash
docker compose up -d
```

To stop the containers:

```bash
docker compose down
```

---

# 🔐 Security Considerations

BuildResume follows several security practices:

* JWT-based authentication
* Email OTP verification
* Protected backend routes
* Environment variables for secrets
* No API keys committed to source control
* Database-backed user isolation

Sensitive configuration values should always be stored in environment variables.

---

# 📸 Screenshots

Add screenshots of the application here once the UI is finalized.

### Home Page

```text
/screenshots/home.png
```

### Resume Builder

```text
/screenshots/resume-builder.png
```

### AI Assistant

```text
/screenshots/ai-assistant.png
```

### Resume Templates

```text
/screenshots/templates.png
```

Example:

```markdown
![BuildResume Home](screenshots/home.png)

![Resume Builder](screenshots/resume-builder.png)

![AI Assistant](screenshots/ai-assistant.png)
```

---

# 🗺️ Future Improvements

Some potential future improvements include:

* [ ] Additional professional resume templates
* [ ] Resume version management
* [ ] Job-description based resume optimization
* [ ] ATS compatibility analysis
* [ ] AI-powered keyword recommendations
* [ ] Resume scoring
* [ ] Cloud-based resume storage
* [ ] Public resume sharing
* [ ] Import resume from existing PDF/DOCX
* [ ] More customization options
* [ ] Mobile-responsive improvements

---

# 🎯 Why BuildResume?

Creating a professional resume often requires repeatedly switching between document editors, templates, job descriptions, and online resume tools.

BuildResume attempts to bring these capabilities into a single platform:

```text
Resume Creation
       +
Template Customization
       +
AI Assistance
       +
Real-time Preview
       +
User Authentication
       +
Persistent Storage
       ↓
    BuildResume
```

The project also provided practical experience in building a full-stack application involving frontend development, REST APIs, authentication, databases, ORM, migrations, AI API integration, and containerization.

---

# 🧠 Key Learning Outcomes

Through BuildResume, I gained hands-on experience with:

* Designing a full-stack application architecture
* Building REST APIs using FastAPI
* Working with PostgreSQL
* Using SQLAlchemy ORM
* Managing database migrations with Alembic
* Implementing JWT authentication
* Implementing email OTP verification
* Integrating generative AI APIs
* Managing frontend state using Vanilla JavaScript
* Designing reusable resume templates
* Building interactive and resizable UI components
* Containerizing applications using Docker
* Separating frontend, backend, database, and business logic responsibilities

---

# 🔮 Future Vision

The long-term goal of BuildResume is to evolve from a simple resume builder into an **AI-powered career document platform** that can help users:

* Build resumes
* Optimize resumes for specific job descriptions
* Identify missing skills and keywords
* Improve resume content
* Generate tailored versions of resumes
* Track multiple resume versions
* Create job-specific applications

---

# 🤝 Contributing

Contributions are welcome.

If you would like to contribute:

1. Fork the repository.
2. Create a new branch.

```bash
git checkout -b feature/new-feature
```

3. Make your changes.
4. Commit your changes.

```bash
git commit -m "Add new feature"
```

5. Push the branch.

```bash
git push origin feature/new-feature
```

6. Open a Pull Request.

---

# 📄 License

This project is currently intended for educational and portfolio purposes.

If a specific open-source license is added to the repository, this section should be updated accordingly.

---

# 👨‍💻 Author

**Krishna Singhal**

B.Tech Computer Science
Jaypee Institute of Information Technology, Noida

### Connect with me

* GitHub: https://github.com/Krishnasinghal78
* LinkedIn: https://www.linkedin.com/in/krishna-singhal-149171285/
* LeetCode: https://leetcode.com/u/23103105/

---

⭐ If you found this project interesting, consider giving the repository a star!
