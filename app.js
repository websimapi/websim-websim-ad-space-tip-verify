/* Simple ad-tip + verification app using window.websim APIs and WebsimSocket records.
   Mobile-friendly minimal UI. */

async function main() {
const form = document.getElementById('adForm');
const adsList = document.getElementById('adsList');
const refreshBtn = document.getElementById('refreshAds');
const watchWrap = document.getElementById('watchWrap');
const watchArea = document.getElementById('watchArea');
const watchStatus = document.getElementById('watchStatus');

let room = null;

// helper: instantiate WebsimSocket if present
async function getRoom() {
  if (room) return room;
  if (window.WebsimSocket) {
    try { room = new WebsimSocket(); return room; } catch (e) { console.warn(e); }
  }
  // fallback: try connectSocket then wrap a minimal API around it to use collection()
  if (window.websim && window.websim.connectSocket) {
    try {
      const sock = await window.websim.connectSocket();
      // Minimal stub that exposes collection().create/getList/subscribe using a simple fetch-based fallback.
      room = {
        collection(type) {
          return {
            async create(data) {
              // store via a simple POST to an app-level endpoint if exists; fallback to no-op
              return fetch(`/api/record/${type}`, {method:'POST',body:JSON.stringify(data)}).then(r=>r.json()).catch(()=>({ ...data, id:Date.now().toString() }));
            },
            getList() { return Promise.resolve([]); },
            filter() { return { getList: ()=>Promise.resolve([]), subscribe: ()=>()=>{} }; },
            subscribe(fn){ return ()=>{} }
          };
        }
      };
      return room;
    } catch (e) {
      console.warn('socket connect failed', e);
    }
  }
  // last resort: dummy
  room = {
    collection(){ return { create: async (d)=> ({...d, id:Date.now().toString()}), getList: async ()=>[] , subscribe: ()=>()=>{} } }
  };
  return room;
}

async function currentProjectId() {
  try {
    const p = await window.websim.getCurrentProject();
    return p?.id || 'unknown_project';
  } catch { return 'unknown_project'; }
}

// enforce websim-only URLs
function isWebsimUrl(url) {
  return typeof url === 'string' && (url.includes('api.websim.com') || url.includes('images.websim.com') || url.includes('/blobs/'));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const title = (f.get('title') || '').trim();
  const desc = (f.get('desc') || '').trim();
  const credits = Number(f.get('credits') || 0);
  const file = f.get('video');

  if (!file || file.size === 0) return alert('Please pick a video file.');
  try {
    form.querySelector('button[type=submit]').disabled = true;
    form.querySelector('button[type=submit]').textContent = 'Uploading...';

    // upload via websim.upload (returns a websim blob url)
    const url = await window.websim.upload(file);
    if (!isWebsimUrl(url)) {
      throw new Error('Uploaded file URL is not a websim url.');
    }

    // create a tip comment (this ties the tip to the project and creator)
    const commentText = `Ad: ${title}\n\n${desc}\n\n[video](${url})`;
    const postResult = await window.websim.postComment({
      content: commentText,
      images: [],
      credits: credits
    });
    if (postResult?.error) throw new Error(postResult.error);

    // persist ad metadata in a room collection
    const roomObj = await getRoom();
    const project_id = await currentProjectId();
    const record = await roomObj.collection('ad_tip_v1').create({
      project_id,
      title,
      description: desc,
      credits,
      video_url: url,
      created_at: new Date().toISOString(),
      // comment/post linking would be picked up by the platform; save placeholder
      comment_posted: true
    });

    alert('Ad created and tipped. It will appear in active ads shortly.');
    form.reset();
    loadAds();
  } catch (err) {
    console.error(err);
    alert('Error creating ad: ' + (err.message || err));
  } finally {
    form.querySelector('button[type=submit]').disabled = false;
    form.querySelector('button[type=submit]').textContent = 'Submit & Tip';
  }
});

refreshBtn.addEventListener('click', loadAds);

async function loadAds() {
  adsList.innerHTML = 'Loading...';
  const roomObj = await getRoom();
  // read all ad_tip_v1 records (getList may return newest-first)
  let list = [];
  try {
    const maybe = await roomObj.collection('ad_tip_v1').getList();
    list = (maybe && typeof maybe.then === 'function') ? await maybe : (Array.isArray(maybe) ? maybe : []);
  } catch (e) {
    list = [];
  }
  // sort by credits desc then random jitter as described
  const decorated = (list || []).map(r => ({...r, rand: Math.random()}))
    .sort((a,b)=> (b.credits - a.credits) || (b.rand - a.rand));

  if (!decorated.length) {
    adsList.innerHTML = '<div class="small">No active ads found.</div>';
    return;
  }

  adsList.innerHTML = '';
  for (const ad of decorated) {
    const adEl = document.createElement('div');
    adEl.className = 'ad';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.textContent = 'Video';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<h3>${escapeHtml(ad.title || 'Untitled')}</h3><p>${escapeHtml(ad.description || '')}</p>
      <div class="actions"><button class="linkbtn" data-url="${(ad.video_url||'')}" data-id="${ad.id}">Watch (verify)</button>
      <span class="small" style="margin-left:8px">tips: ${ad.credits||0}</span></div>`;
    adEl.appendChild(thumb);
    adEl.appendChild(meta);
    adsList.appendChild(adEl);

    const btn = meta.querySelector('button');
    btn.addEventListener('click', ()=> startWatch(ad));
  }
}

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Verification flow:
// - load video element (must be websim url).
// - while playing sample frames to canvas at 1fps.
// - collect simple frame hashes (dataURL slices) and store watch event when viewer watched >= 50% time.
async function startWatch(ad) {
  watchWrap.hidden = false;
  watchArea.innerHTML = '';
  watchStatus.textContent = 'Preparing player...';

  const v = document.createElement('video');
  v.controls = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = ad.video_url;
  v.crossOrigin = 'anonymous';
  watchArea.appendChild(v);

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `Ad: ${ad.title} — tips: ${ad.credits || 0}`;
  watchArea.appendChild(info);

  // canvas for frame capture
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // --- START: webcam recording setup ---
  let mediaStream = null;
  let mediaRecorder = null;
  let camChunks = [];
  async function startCamRecording() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm;codecs=vp8' });
      camChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) camChunks.push(e.data); };
      mediaRecorder.start(1000);
    } catch (e) {
      console.warn('Camera not available:', e);
    }
  }
  function stopCamRecording() {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream = null; }
    } catch(e){}
  }
  // --- END: webcam recording setup ---

  // capture state
  let captures = [];
  let captureInterval = null;

  function startCaptures() {
    if (captureInterval) return;
    startCamRecording(); // begin webcam capture when sampling starts
    captureInterval = setInterval(() => {
      try {
        canvas.width = Math.min(320, v.videoWidth || 320);
        canvas.height = Math.min(180, v.videoHeight || 180);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        // sample a small data URL to avoid huge payloads
        const data = canvas.toDataURL('image/jpeg', 0.4);
        // simple "hash" = first 60 chars of base64
        captures.push({ t: Math.round(v.currentTime*1000), sample: data.slice(0, 200) });
        watchStatus.textContent = `Capturing... ${captures.length} samples`;
      } catch (e) {
        // ignore draw errors if video not ready
      }
    }, 1000); // 1fps sampling
  }
  function stopCaptures() {
    if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
    stopCamRecording(); // ensure camera stops when captures stop
  }

  // when user plays, start capturing; when paused, stop. On ended, evaluate.
  v.addEventListener('play', ()=> startCaptures());
  v.addEventListener('pause', ()=> watchStatus.textContent = 'Paused — verification paused.');
  v.addEventListener('ended', async ()=> {
    stopCaptures();
    watchStatus.textContent = 'Video ended — verifying...';
    try {
      // build camera blob if available
      let cameraBlob = (camChunks && camChunks.length) ? new Blob(camChunks, { type: 'video/webm' }) : null;
      const rec = await submitWatchProof(ad, captures, cameraBlob);
      // show recorded viewing clip preview if present
      if (rec?.camera_url) {
        const pv = document.createElement('video');
        pv.controls = true; pv.src = rec.camera_url; pv.style.maxWidth='180px'; watchArea.appendChild(pv);
      }
      watchStatus.textContent = 'Video ended — verification submitted.';
    } catch (err) {
      console.error(err);
      watchStatus.textContent = 'Verification failed: '+(err.message||err);
    }
  });

  // quick "skip-check": if user watches >=50% (based on timeplayed events) we'll submit proof mid-play.
  let lastTime = 0, watchedMs = 0;
  const tick = setInterval(() => {
    if (v.paused || v.ended) return;
    const now = v.currentTime;
    const delta = Math.max(0, (now - lastTime) * 1000);
    watchedMs += delta;
    lastTime = now;
    const durationMs = (v.duration || 0) * 1000;
    const pct = durationMs ? (watchedMs / durationMs) : 0;
    watchStatus.textContent = `Watching: ${(pct*100).toFixed(0)}% — samples ${captures.length}`;
    // when >=50% watched, submit a proof event (but keep allowing continued capture)
    if (durationMs && pct >= 0.5) {
      clearInterval(tick);
      stopCaptures();
      try {
        let cameraBlob = (camChunks && camChunks.length) ? new Blob(camChunks, { type: 'video/webm' }) : null;
        const rec = await submitWatchProof(ad, captures, cameraBlob);
        if (rec?.camera_url) {
          const pv = document.createElement('video');
          pv.controls = true; pv.src = rec.camera_url; pv.style.maxWidth='180px'; watchArea.appendChild(pv);
        }
        watchStatus.textContent = 'Verified (>=50%). Thank you!';
      } catch (err) {
        console.error(err);
        watchStatus.textContent = 'Verification failed: '+(err.message||err);
      }
    }
  }, 800);

  // autoplay attempt for mobile: user must interact to play; otherwise they can press play.
  try { await v.play(); } catch {}
}

// submit captured proof to ad_watch collection
async function submitWatchProof(ad, captures, cameraBlob=null) {
  const roomObj = await getRoom();
  const project_id = await currentProjectId();
  const user = await window.websim.getCurrentUser().catch(()=>null);

  // upload camera blob (if present) to websim and validate url
  let camera_url = null;
  if (cameraBlob && window.websim && window.websim.upload) {
    try {
      const uploaded = await window.websim.upload(new File([cameraBlob], `watch_${Date.now()}.webm`, { type: cameraBlob.type }));
      if (isWebsimUrl(uploaded)) camera_url = uploaded;
    } catch (e) { console.warn('camera upload failed', e); }
  }

  const payload = {
    project_id,
    ad_id: ad.id,
    ad_title: ad.title,
    viewer_id: user?.id || null,
    viewer_username: user?.username || null,
    captured_at: new Date().toISOString(),
    sample_count: captures.length,
    samples: captures.slice(0, 40), // keep small
    camera_url,
  };
  const rec = await roomObj.collection('ad_watch_v1').create(payload);
  // augment returned record with camera_url for UI convenience
  return { ...rec, camera_url };
}

// initial load
loadAds().catch(()=>{ adsList.innerHTML = 'Failed to load ads.' });

}

document.addEventListener('DOMContentLoaded', () => {
  main().catch(err=>console.error(err));
}); /* end main startup */