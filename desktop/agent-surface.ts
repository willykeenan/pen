const params = new URLSearchParams(window.location.search);
const label = params.get("label") || "Agent";
const task = params.get("task") || "isolated-test";
const color = params.get("color") || "#66d9ff";
const proof = params.get("proof") === "1";

document.documentElement.style.setProperty("--agent-color", color);
setText("agent-label", label);
setText("task-id", task);
if (proof) document.body.dataset.proof = "true";

const submit = document.getElementById("fixture-submit") as HTMLButtonElement | null;
const input = document.getElementById("fixture-input") as HTMLInputElement | null;
const result = document.getElementById("fixture-result");
submit?.addEventListener("click", () => {
  if (!result || !input) return;
  result.textContent = input.value.trim()
    ? `Fixture accepted “${input.value.trim().slice(0, 40)}”. No external action occurred.`
    : "Type a fixture value first.";
});

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}
