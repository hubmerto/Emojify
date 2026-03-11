const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file");
const processBtn = document.getElementById("process");
const statusEl = document.getElementById("status");
const fpsInput = document.getElementById("fps");
const sizeInput = document.getElementById("size");
const formatSelect = document.getElementById("format");
const presetSelect = document.getElementById("preset");
const dropTitle = document.getElementById("drop-title");
const dropSub = document.getElementById("drop-sub");
const fpsControl = document.getElementById("fps-control");
const presetControl = document.getElementById("preset-control");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const previewPlaceholder = document.getElementById("preview-placeholder");
const previewContent = document.getElementById("preview-content");
const previewActions = document.getElementById("preview-actions");
const downloadLink = document.getElementById("download-link");
let selectedFile = null;

const presets = {
  custom: null,
  fast: { fps: 10, size: 16 },
  balanced: { fps: 8, size: 12 },
  detail: { fps: 5, size: 8 },
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(pct) {
  if (pct <= 0) {
    progressWrap.style.display = "none";
    progressBar.style.width = "0%";
  } else {
    progressWrap.style.display = "";
    progressBar.style.width = pct + "%";
  }
}

function setBusy(isBusy) {
  processBtn.disabled = isBusy;
  fileInput.disabled = isBusy;
}

function currentMediaKind(file) {
  if (!file) return "unknown";
  if ((file.type || "").startsWith("image/")) return "image";
  if ((file.type || "").startsWith("video/")) return "video";
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)) return "image";
  if (/\.(mp4|mov|m4v|avi|mkv|webm)$/.test(name)) return "video";
  return "unknown";
}

function refreshFormForFile(file) {
  const kind = currentMediaKind(file);
  if (kind === "image") {
    dropTitle.textContent = "Drop image here";
    dropSub.textContent = "or click to pick an image file";
    formatSelect.innerHTML = `
      <option value="png">PNG</option>
      <option value="jpg">JPG</option>
    `;
    fpsControl.style.display = "none";
    presetControl.style.display = "none";
  } else {
    dropTitle.textContent = "Drop video here";
    dropSub.textContent = "or click to pick a file";
    formatSelect.innerHTML = `
      <option value="mp4">MP4</option>
      <option value="gif">GIF</option>
    `;
    fpsControl.style.display = "";
    presetControl.style.display = "";
  }
}

function showPreview(jobId, format, mediaKind) {
  const url = `/preview/${jobId}`;
  previewContent.innerHTML = "";

  if (mediaKind === "image" || format === "gif") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Mosaic preview";
    previewContent.appendChild(img);
  } else {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    previewContent.appendChild(video);
  }

  previewPlaceholder.style.display = "none";
  previewContent.style.display = "flex";
  previewActions.style.display = "flex";
  downloadLink.href = `/download/${jobId}`;
}

function resetPreview() {
  previewPlaceholder.style.display = "flex";
  previewContent.style.display = "none";
  previewActions.style.display = "none";
  previewContent.innerHTML = "";
}

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("drag");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  const [file] = e.dataTransfer.files;
  if (file) {
    selectedFile = file;
    refreshFormForFile(file);
    setStatus(`Selected: ${file.name}`);
    resetPreview();
  }
});

fileInput.addEventListener("change", (e) => {
  const [file] = e.target.files;
  if (file) {
    selectedFile = file;
    refreshFormForFile(file);
    setStatus(`Selected: ${file.name}`);
    resetPreview();
  }
});

let currentJobFormat = "mp4";
let currentMediaKindValue = "video";

processBtn.addEventListener("click", async () => {
  if (!selectedFile) {
    setStatus("Choose a video or image first.");
    return;
  }

  const kind = currentMediaKind(selectedFile);
  if (kind === "unknown") {
    setStatus("Unsupported file type.");
    return;
  }

  currentMediaKindValue = kind;

  if (kind === "video") {
    const preset = presetSelect.value;
    if (preset !== "custom") {
      const values = presets[preset];
      fpsInput.value = values.fps;
      sizeInput.value = values.size;
    }
  }

  currentJobFormat = formatSelect.value;

  const formData = new FormData();
  formData.append("media", selectedFile);
  formData.append("fps", fpsInput.value);
  formData.append("size", sizeInput.value);
  formData.append("format", formatSelect.value);

  setBusy(true);
  setStatus("Processing...");
  setProgress(5);
  resetPreview();

  try {
    const response = await fetch("/process", { method: "POST", body: formData });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Processing failed");
    }

    const { job_id } = await response.json();
    pollJob(job_id);
  } catch (err) {
    setStatus(err.message || "Something went wrong.");
    setProgress(0);
    setBusy(false);
  }
});

presetSelect.addEventListener("change", () => {
  const preset = presetSelect.value;
  if (preset === "custom") return;
  const values = presets[preset];
  fpsInput.value = values.fps;
  sizeInput.value = values.size;
});

async function pollJob(id) {
  try {
    const res = await fetch(`/status/${id}`);
    if (!res.ok) throw new Error("status failed");
    const data = await res.json();

    setStatus(data.message || data.status);
    setProgress(data.progress || 0);

    if (data.status === "done") {
      setStatus("done");
      setProgress(100);
      showPreview(id, currentJobFormat, currentMediaKindValue);
      setTimeout(() => {
        setProgress(0);
        setBusy(false);
      }, 500);
      return;
    }

    if (data.status === "error") {
      setStatus("Error: " + (data.message || "Processing failed"));
      setProgress(0);
      setBusy(false);
      return;
    }
  } catch (err) {
    setStatus("Error checking status");
    setProgress(0);
    setBusy(false);
    return;
  }

  setTimeout(() => pollJob(id), 1500);
}
