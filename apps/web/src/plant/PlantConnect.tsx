import { useEffect, useSyncExternalStore } from "react";
import { faceInfo } from "./VirtualPlant";
import { plantSerial } from "./serial";

// Connects the real plant robot over USB, under the on-screen one. The robot then mirrors every face.
export function PlantConnect() {
  const status = useSyncExternalStore(plantSerial.subscribe, plantSerial.getStatus);
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
      {note && <p className="plant-link-note" role="alert">{note}</p>}
    </div>
  );
}
