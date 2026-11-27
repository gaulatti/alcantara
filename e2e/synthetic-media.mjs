// A generated camera and microphone for an engine with no fake-device switch (WebKit). A moving canvas and a steady
// tone reach the guest's peer connection as real tracks, so the bytes-flowing checks measure the same path.
export const SYNTHETIC_MEDIA = `(() => {
  // Patched on the prototype: WebKit does not expose navigator.mediaDevices yet when an init script runs, so patching the
  // instance did nothing and the page's own request was refused (NotAllowedError, "camera or microphone blocked").
  const md = window.MediaDevices && window.MediaDevices.prototype;
  if (!md) return;
  md.getUserMedia = async function (constraints = {}) {
    const tracks = [];
    if (constraints.video) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      let frame = 0;
      setInterval(() => {
        frame += 1;
        ctx.fillStyle = "hsl(" + (frame % 360) + ",60%,40%)";
        ctx.fillRect(0, 0, 320, 240);
      }, 100);
      tracks.push(...canvas.captureStream(10).getVideoTracks());
    }
    if (constraints.audio) {
      const audio = new AudioContext();
      const osc = audio.createOscillator();
      osc.frequency.value = 440;
      const dest = audio.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      tracks.push(...dest.stream.getAudioTracks());
    }
    return new MediaStream(tracks);
  };
  md.enumerateDevices = async function () {
    return [
    { deviceId: "synthetic-camera", kind: "videoinput", label: "Synthetic camera", groupId: "g" },
    { deviceId: "synthetic-mic", kind: "audioinput", label: "Synthetic microphone", groupId: "g" },
    ];
  };
})();`;
