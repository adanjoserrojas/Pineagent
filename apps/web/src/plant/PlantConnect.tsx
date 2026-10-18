import { useEffect, useSyncExternalStore } from "react";
import { faceInfo } from "./VirtualPlant";
import { plantSerial } from "./serial";

// Connects the real plant robot over USB, under the on-screen one. The robot then mirrors every face,
// with a sound or an arm wave for the moments that matter (cues.ts).
export function PlantConnect() {
  const status = useSyncExternalStore(plantSerial.subscribe, plantSerial.getStatus);
  const prefs = useSyncExternalStore(plantSerial.subscribe, plantSerial.getPrefs);
  useEffect(() => void plantSerial.resume(), []);

  if (status.state === "unsupported") {
    return <p className="plant-link plant-link-note">To connect the robot over USB, open this page in desktop Chrome or Edge.</p>;
  }
  const on = status.state === "on";
  const text = on
    ? status.face ? `Robot connected · ${faceInfo(status.face).title}` : "Robot connected"
    : status.state === "connecting" ? "Connecting to the robot…" : "Robot not connected";
  const note = status.state === "on" ? status.problem : status.state === "off" ? status.note : undefined;

  return (
    <div className="plant-link" data-robot={status.state}>
      <span role="status">{text}</span>
      <button
        type="button"
        className="link-btn"
        disabled={status.state === "connecting"}
        onClick={() => void (on ? plantSerial.disconnect() : plantSerial.connect())}
      >
        {on ? "Disconnect" : "Connect robot"}
      </button>
      {on && (
        <div className="plant-link-controls">
          <label><input type="checkbox" checked={prefs.sound} onChange={(e) => plantSerial.setPrefs({ sound: e.target.checked })} /> Sound</label>
          <label><input type="checkbox" checked={prefs.arms} onChange={(e) => plantSerial.setPrefs({ arms: e.target.checked })} /> Arms</label>
          <button type="button" className="link-btn" onClick={() => void plantSerial.test("done")}>Celebrate</button>
        </div>
      )}
      {on && status.power === false && (
        <p className="plant-link-note">No 5 V supply: the arms stay still and the piezo plays instead of the speaker.</p>
      )}
      {note && <p className="plant-link-note" role="alert">{note}</p>}
    </div>
  );
}
