# Operator quick start: a guest call

For one operator running a show alone. Labels are the words on screen, spelled as they appear. Pages: the console is `/` (the radio desk); guest calls are `/calls`.

## Before the show

1. Open `/calls`. If it says **Guest calls need LiveKit**, calls are not set up here; stop.
2. Wait for **LiveKit connected** at the top of the page.
3. Watch for an amber line under the header. It appears only when part of the call chain is down, and names the problem (for example **Guests can't reach air right now.**). Do not cue anyone live while it shows. It clears by itself. The same check is available to automation as the MCP tool titled **Check that calls work** (`webrtc_health`).

## The steps

1. **Invite and send the link.** On `/calls`, type the guest's name in **Guest name**, choose how long the link lasts under **Expires after** (24 hours by default), then press **Create private link**. The link is copied; send it. If the copy was refused, press **Copy invitation**.

2. **The guest waits.** They join from their phone, play the test tone, confirm headphones and press **Join studio**. Their page says **Waiting for the producer to let you in** and shows **Off air**. On `/calls` they appear under **Waiting**. On the console, the top strip reads "<name>: waiting".

3. **Pre-fade listen.** On the console, in **Guests**, press **PFL** beside them. You hear them on this device only. If your own mic is live you hear nothing unless you are on headphones (see step 7).

4. **Admit.** On `/calls`, press **Admit** on their row. They become a live strip.

5. **Check they hear the studio.** Wait for **Hears the studio** on their strip. If it shows **Studio sound not reaching guest** instead, see step 10.

6. **Cue live.** Press **Cue live**, then press it again (or Space). The button keeps its place while armed. The cue line reads **Cue · live**, and the guest's page shows **You're on air** in a large red banner. Air follows about **6 seconds** after the cue (measured at 5.67 to 6.15 s), so cue a beat early.

7. **Mic on air for yourself.** Press **Mic on air**, on the radio desk's top strip or on `/calls`. It turns to **ON AIR · Mic on air**, and every page's header shows **Mic on air** with an **Off** button, so you can go back to the desk and watch the clock while you talk.
   - It comes off air when you press it again or press **Off**, when you switch shows, or when you sign out. Moving between console pages does not turn it off.
   - **While your mic is live the desk is quiet.** **Listen** is muted and says **Muted while your mic is live**. Every **PFL**, sounder pre-listen, **Preview locally** and waiting guest's **Talk privately** audio is muted too, because speakers would feed back into your mic.
   - **On headphones?** Tick **I'm on headphones: keep pre-fade** beside the mic button. PFL and previews play again, this device remembers it, and the header says **PFL on headphones** instead of **PFL muted**. **Listen** stays muted either way. Untick it before you use speakers.
   - Only one host mic is on air for a show. If you press **Mic on air** in another tab or on another device, that one takes over.
   - If the studio takes your microphone off air (the operator action `webrtc_host_mic_off`), the console drops you off air at once, and the header shows **Mic is off air**; under the button it says **The studio muted the host microphone. It is off air.**
   - Turning your microphone on from the studio side is **not yet** possible.

8. **Talkback, which never reaches air.** Hold **Hold · talk (T)** on a guest's strip (or hold T) to speak to that guest alone. It says **Talking… release to stop** while held. Only that guest hears you, in their own return. Talk never reaches the radio's air or the program. **Allow private talk while live (never on air)** only lets the button work while the guest is cued live; it does not put talk on air. For a guest not yet admitted, use **Talk privately** on their waiting row; with your mic live you only hear them if headphones are ticked.

9. **Standby and wrap.** **Standby** takes a guest off air and keeps them on the call; the cue line reads **Cue · standby** and their page shows **Off air**. To end a guest's air time, hold **Hold · cue wrap** until it says **Keep holding…** and let go; the line reads **Cue · wrap sent** and their page shows **Off air**. If a live guest drops and rejoins, the server takes them off air: the line reads **Off air · rejoined, cue again**. Cue them again when you want them back.

10. **When a guest reports no studio sound.** If your strip shows **Studio sound not reaching guest**, the guest sees "The studio sound isn't reaching you yet." Tell them to check their headphones and volume and to keep talking. The strip clears by itself and shows **Hears the studio** once the sound arrives. If it does not clear, ask them to leave and rejoin with the same link (**Leave**, then **Rejoin the studio**). Do not cue them live until **Hears the studio** shows.

## Guests who cannot connect

Some guest networks block UDP and the usual TCP port. TURN over TLS on port 443 is live for those: the guest does
nothing different. If a guest still cannot join, their row on `/calls` says why their last join failed; ask them to
switch network (Wi-Fi or mobile data) and rejoin with the same link. The guest page says so: "Check your Wi-Fi or
mobile data, then try again."

Guests cannot chat with you or share their screen, and nothing records the call.
