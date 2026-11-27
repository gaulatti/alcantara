# Operator quick start: a guest call, start to finish

For one operator running a show alone. Labels are the buttons and text you will see on screen, spelled as they appear.
Where a step names a page, it is the console at `/` (the radio desk), or Guest calls at `/calls`.

## Before the show

1. Open **Guest calls** (`/calls`). If it says **Guest calls need LiveKit**, calls are not set up on this deployment; stop here.
2. Check the top of the page shows **LiveKit connected**. If it shows **Checking LiveKit…** wait for it.

## The steps

1. **Create an invite and send the link.** On `/calls`, type the guest's name in **Guest name**, pick how long the link lasts under **Expires after** (24 hours is the default), then press **Create private link**. The page says the link is copied. Paste it to the guest. If the copy was refused, press **Copy invitation** and send it yourself.

2. **The guest waits.** The guest opens the link on their phone, plays the test tone, confirms headphones and presses **Join studio**. They see **Waiting for the producer to let you in** and "You are not on air". On `/calls` their slot moves into the **Waiting** list. On the console, the top strip reads "<name>: waiting", or "Guests: N waiting" when there is more than one guest.

3. **Pre-fade listen to them.** On the console, in the **Guests** section, press **PFL** next to the guest. You hear them on this device only; nothing goes to air or to the guest. Press **PFL** again, or press Esc, to stop.

4. **Admit.** On `/calls`, in **Waiting**, press **Admit** on their row. Their slot becomes a live guest strip. The guest sees their page change to live once their return sound arrives.

5. **Check "Hears the studio".** On their guest strip, wait for the line **Hears the studio**. It means the guest's page reports they are hearing the studio. Do not cue them before you see it.

6. **Cue live.** On their strip, press **Cue live**, then press it again (or press Space) to confirm; the button reads **Press again or Space: cue live** until then. The strip then shows **Live · cued** and "Cued live: they go out on the radio…". Air follows about 6 seconds after the cue (measured at 5.67 to 6.15 s; see the cue note in `docs/operator-interface.md`), so cue a beat early, not on the word. To stand them by instead, press **Standby**.

7. **Mic on air for yourself.** On `/calls`, press **Mic on air**. It turns to **ON AIR · Mic on air** while your microphone is on air. Press it again to take yourself off air. Leaving the page also takes you off air.

8. **Talkback, which never reaches air.** On a guest's strip, hold **Hold · talk (T)** (or hold the T key) to speak to that guest alone. It says **Talking… release to stop** while held. The guest hears you in their own return mix only. Talk never goes to the radio's air or to the program mix, whatever is ticked. The **Allow private talk while live (never on air)** tick only lets that button work while the guest is cued live; it does not put talk on air. To talk to a guest who is not yet admitted, press **Talk privately** on their waiting row; it is private and not on air.

9. **Wrap.** On the cued guest's strip, hold **Hold · cue wrap** until it says **Keep holding…** and lets go. The guest comes off air. Press **Standby** to keep them on the call without air, or revoke their link when they are finished.

10. **What the guest sees, and what to do when it shows "Studio sound not reaching guest".**
    - Invited, joined and waiting: "Waiting for the producer to let you in".
    - Admitted and hearing the studio: "You're hearing the studio".
    - Admitted but the studio sound has not reached them after 15 seconds: your strip shows **Studio sound not reaching guest** in amber, and the guest sees "The studio sound isn't reaching you yet. The producer can see this; you can keep talking."
    - What to do: tell the guest to check their headphones and volume, and to keep talking. The strip clears by itself and reads **Hears the studio** again once the sound arrives. If it does not clear, ask the guest to leave and rejoin with the same link (**Leave**, then **Rejoin the studio**). Do not cue them live until **Hears the studio** shows.
