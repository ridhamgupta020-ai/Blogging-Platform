/* =========================
   SIGNUP
========================= */
function signup() {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value.trim();

  if (!name || !email || !password) {
    alert("Please fill all fields");
    return;
  }

  const user = {
    name,
    email,
    password
  };

  localStorage.setItem("user", JSON.stringify(user));
  alert("Signup successful! Please login.");
  window.location.href = "login.html";
}

/* =========================
   LOGIN
========================= */
function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value.trim();

  const savedUser = JSON.parse(localStorage.getItem("user"));

  if (!savedUser) {
    alert("No user found. Please sign up first.");
    return;
  }

  if (email === savedUser.email && password === savedUser.password) {
    localStorage.setItem("loggedIn", "true");
    alert("Login successful!");
    window.location.href = "index.html";
  } else {
    alert("Invalid email or password");
  }
}

/* =========================
   LOGOUT
========================= */
function logout() {
  localStorage.removeItem("loggedIn");
  window.location.href = "login.html";
}

/* =========================
   SHOW USER NAME (OPTIONAL)
========================= */
const user = JSON.parse(localStorage.getItem("user") || "{}");
const userNameEl = document.getElementById("userName");
if (userNameEl) {
  userNameEl.innerText = user.name || "Guest";
}
