const routeForm = document.querySelector("#route-form");
const formMessage = document.querySelector("#form-message");

routeForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(routeForm);
  const from = String(formData.get("from")).trim();
  const to = String(formData.get("to")).trim();

  if (!from || !to) {
    formMessage.textContent = "Add both places to check a route.";
    return;
  }

  formMessage.textContent = `Route search coming soon for ${from} to ${to}.`;
});