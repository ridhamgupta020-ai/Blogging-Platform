if (!localStorage.getItem("loggedIn")) {
  alert("Please login to access this page");
  window.location.href = "login.html";
}
