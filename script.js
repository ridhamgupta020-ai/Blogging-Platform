/* =========================
   AUTH PROTECTION
========================= */
if (document.body.dataset.protected === "true") {
  if (!localStorage.getItem("loggedIn")) {
    alert("Please login first");
    window.location.href = "login.html";
  }
}

/* =========================
   GLOBAL STATE
========================= */
let editingId = null;
let coverImage = null;

/* =========================
   TEXT FORMAT
========================= */
function cmd(command, value = null) {
  document.execCommand(command, false, value);
}

/* =========================
   INLINE IMAGE UPLOAD
========================= */
function uploadImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";

  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      document.execCommand("insertImage", false, reader.result);
    };
    reader.readAsDataURL(file);
  };

  input.click();
}

/* =========================
   COVER IMAGE UPLOAD
========================= */
const coverInput = document.getElementById("coverInput");
const coverPreview = document.getElementById("coverPreview");

if (coverInput) {
  coverInput.addEventListener("change", () => {
    const file = coverInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      coverImage = reader.result;
      if (coverPreview) {
        coverPreview.src = coverImage;
        coverPreview.style.display = "block";
      }
    };
    reader.readAsDataURL(file);
  });
}

/* =========================
   TEMPLATE SYSTEM
========================= */
function applyTemplate() {
  const select = document.getElementById("templateSelect");
  const editor = document.getElementById("content");
  if (!select || !editor) return;

  const templates = {
    seo: `
<h1>Main SEO Title</h1>
<p><strong>Meta Description:</strong></p>
<h2>Introduction</h2>
<p>Intro text...</p>
<h2>FAQs</h2>
<p>Q&A</p>
<h2>Conclusion</h2>
<p>CTA</p>`,

    blog: `
<h2>Introduction</h2>
<p>Intro...</p>
<h2>Main Content</h2>
<p>Details...</p>
<h2>Conclusion</h2>
<p>CTA</p>`,

    tutorial: `
<h2>What You Will Learn</h2>
<ul><li>Step 1</li><li>Step 2</li></ul>
<h2>Final Result</h2>`,

    news: `
<h2>Headline Summary</h2>
<p>Overview...</p>
<h2>Why It Matters</h2>`,

    case: `
<h1>Case Study</h1>
<h2>Problem</h2>
<h2>Solution</h2>
<h2>Results</h2>`,

    review: `
<h1>Product Review</h1>
<h2>Pros</h2>
<h2>Cons</h2>
<h2>Verdict</h2>`,

    markdown: `
# Blog Title
## Introduction
Text here

\`\`\`js
console.log("Hello");
\`\`\`
`
  };

  if (select.value === "markdown") {
    editor.innerText = templates.markdown;
  } else {
    editor.innerHTML = templates[select.value] || "";
  }

  select.value = "";
}

/* =========================
   SAVE / UPDATE BLOG
========================= */
function publish() {
  const title = document.getElementById("title")?.value.trim();
  const tagsRaw = document.getElementById("tags")?.value.trim();
  const content = document.getElementById("content")?.innerHTML.trim();

  if (!title || !content) {
    alert("Title and content required");
    return;
  }

  const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()) : [];
  let blogs = JSON.parse(localStorage.getItem("blogs")) || [];

  if (editingId) {
    blogs = blogs.map(b =>
      b.id === editingId
        ? { ...b, title, tags, content, cover: coverImage }
        : b
    );
  } else {
    blogs.unshift({
      id: Date.now(),
      title,
      tags,
      content,
      cover: coverImage,
      date: new Date().toLocaleDateString()
    });
  }

  localStorage.setItem("blogs", JSON.stringify(blogs));
  window.location.href = "blogs.html";
}

/* =========================
   LOAD BLOG FOR EDITOR
========================= */
(function loadEditMode() {
  const editId = localStorage.getItem("editId");
  if (!editId) return;

  const blogs = JSON.parse(localStorage.getItem("blogs")) || [];
  const blog = blogs.find(b => b.id == editId);
  if (!blog) return;

  editingId = blog.id;
  document.getElementById("title").value = blog.title;
  document.getElementById("tags").value = blog.tags.join(", ");
  document.getElementById("content").innerHTML = blog.content;

  coverImage = blog.cover || null;
  if (coverPreview && coverImage) {
    coverPreview.src = coverImage;
    coverPreview.style.display = "block";
  }

  localStorage.removeItem("editId");
})();

/* =========================
   BLOG VIEW (blog.html)
========================= */
(function loadSingleBlog() {
  const container = document.getElementById("blog");
  if (!container) return;

  const params = new URLSearchParams(window.location.search);
  const blogId = Number(params.get("id"));

  const blogs = JSON.parse(localStorage.getItem("blogs")) || [];
  const blog = blogs.find(b => b.id === blogId);

  if (!blog) {
    container.innerHTML = "<p>Blog not found.</p>";
    return;
  }

  container.innerHTML = `
    ${blog.cover ? `<img src="${blog.cover}">` : ""}
    <h1>${blog.title}</h1>
    <div class="date">${blog.date}</div>
    <div class="content">${blog.content}</div>
  `;

  document.title = blog.title + " | VYONIC";
})();

/* =========================
   DARK MODE
========================= */
function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("theme",
    document.body.classList.contains("dark") ? "dark" : "light"
  );
}

if (localStorage.getItem("theme") === "dark") {
  document.body.classList.add("dark");
}

/* =========================
   PDF EXPORT
========================= */
function exportPDF() {
  window.print();
}


function uploadCover(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    coverImage = reader.result;
    const preview = document.getElementById("coverPreview");
    if (preview) {
      preview.src = coverImage;
      preview.style.display = "block";
    }
  };
  reader.readAsDataURL(file);
}

function logout(){
  localStorage.removeItem("loggedIn");
  localStorage.removeItem("user");
  window.location.href="login.html";
}


const authArea = document.getElementById("authArea");
const isLoggedIn = localStorage.getItem("loggedIn");
const user = JSON.parse(localStorage.getItem("user") || "{}");

if (isLoggedIn) {
  authArea.innerHTML = `
    <li>👋 ${user.name || "User"}</li>
    <li><button onclick="logout()">Logout</button></li>
  `;
} else {
  authArea.innerHTML = `
    <li><a href="login.html">Login</a></li>
  `;
}

