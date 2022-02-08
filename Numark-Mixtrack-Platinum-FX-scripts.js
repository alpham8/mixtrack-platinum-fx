/*
    Mixtrack Platinum FX mapping
    Author: Kaj Bostrom

    Notable nonstandard features:
    - HPF & LPF FX buttons remapped to autopan / bitcrush
    - Shift + FX buttons selects focused FX unit + slot
    - "Fader cuts" pad mode remapped to beatjump
    - Shift + Hotcue mapped to cueloop (from Virtual DJ) (not implemented yet)
    - Shift + Sample mapped to key cue / pitch play (from Virtual DJ / Serato DJ Pro) (not implemented yet)
    - Shift + Play starts/ends slip
    - Shift + Sync toggles quantize

    Scratch & nudge code + jogwheel display code adapted from the Mixtrack Pro 3 mapping
    by Stéphane Morin & Radu Suciu and the Mixtrack Platinum mapping by Matthew Nicholson
*/

class MixtrackFX
{
    deckGroups = ["[Channel1]", "[Channel2]", "[Channel3]", "[Channel4]"];
    groupChannels = {};
    shifted = false;
    activeDecks = [0, 1];
    deckRateRangeIdxs = [0, 0, 0, 0];
    deckScratchModes = [false, false, false, false];
    deckScratchStates = [0, 0, 0, 0];
    deckLastScratchTicks = [0, 0, 0, 0];
    deckFastSeekAccums = [0, 0, 0, 0];
    deckWheelStopTimers = [0, 0, 0, 0];
    deckPadModes = [0, 0, 0, 0];
    deckPadLEDConnections = [[],[],[],[]];
    activeFXSlot = 0;
    fxModes = [-1, -1, -1, -1, -1, -1];
    fxMetaTakeover = false;
    instantDoubles = false;
    instantDoublesTimeoutID = 0;
    blinkState = 0;
    /**
     * How many jog ticks correspond to a beatjump in fast seek mode
     */
    fastSeekJogTicks = 4;
    /**
     * How many beats to jump at a time in fast seek mode
     */
    fastSeekRate = 4;

    rateRangeOptions = [0.08, 0.15, 0.5];

    // Pad config
    autoloopSizes = [
        '0.0625', '0.125','0.25', '0.5',
        '1', '2', '4', '8'
    ];

    beatjumpSizes = [
        -2, -1, 1, 2,
        -8, -4, 4, 8,
    ];

    beatjumpSizesShift = [
        -16, -8, 8, 16,
        -64, -32, 32, 64
    ];

    // [channel offset, ctrl]
    genericLEDs = {
        "cue_indicator": [0, 0x01],
        "start": [0, 0x05],
        "play_indicator": [0, 0x00],
        "slip_enabled": [0, 0x04],
        "quantize": [0, 0x03],
        "sync_enabled": [0, 0x02],
        "pfl": [0, 0x1b],
        "loop_enabled": [4, 0x40],
        "reloop_toggle": [4, 0x41],
        "loop_halve": [4, 0x34],
        "loop_double": [4, 0x35],
        "loop_in": [4, 0x36],
        "loop_out": [4, 0x37]
    };

    binaryLEDs = {
        "keylock": [0, 0x0d]
    };

    padModeMap = {
        0x00: 0, // hotcue 1
        0x0D: 1, // loop
        0x07: 2, // "fader cuts" - beatjump
        0x0B: 3, // sample
        0x02: 4, // cueloop
        0x0F: 5, // key cue/pitch play
    };

    padModeAddrs = [0x00, 0x0D, 0x07, 0x0B, 0x02, 0x0F];

    altPadModes = {
        4: 0,
        5: 3
    };

    padFunctions = [
        this.hotcuePad,
        this.autoloopPad,
        this.beatjumpPad,
        this.samplerPad
    ];

    padFunctionsShifted = [
        this.hotcuePadShifted,
        this.autoloopPadShifted,
        this.beatjumpPadShifted,
        this.samplerPad
    ];

    /**
     * Which hardware button labels correspond to which Mixxx FX indices
     */
    fxModeMap = [
        1, // HPF -> Autopan
        5, // LPF -> Bitcrush
        10, // Flanger
        8, // Echo
        18, // Reverb
        17 // Phaser
    ];

    fxBeatsCallbacks = [
        this.fxBeatsCallbackDefault,
        this.fxBeatsCallbackBitcrush,
        this.fxBeatsCallbackDefault,
        this.fxBeatsCallbackDefault,
        this.fxBeatsCallbackDefault,
        this.fxBeatsCallbackDefault
    ];

    constructor()
    {
        const BLINK_TIMER = 500;
        // bpm guide up
        //midi.sendShortMsg(0x90, 0x09, 0x00);
        // bpm guide down
        //midi.sendShortMsg(0x90, 0x0a, 0x00);

        let deckGroup, initPos, control, padMode;

        for (let deck = 0; deck < 4; deck++) {
            deckGroup = this.deckGroups[deck];
            this.groupChannels[deckGroup] = deck;
            for (let mode = 0; mode < 6; ++mode) {
                this.deckPadLEDConnections[deck].push([]);
            }
        }

        // exit demo mode
        sendSysex([0xf0, 0x00, 0x20, 0x7f, 0x03, 0x01, 0xf7]);
        sendSysex([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7]);
        //sendSysex([0xf0, 0x00, 0x20, 0x7f, 0x13, 0xf7]);

        // Make sure decks 1 and 2 are active initially
        midi.sendShortMsg(0x90, 0x08, 0x7f);
        midi.sendShortMsg(0x91, 0x08, 0x7f);

        for (let deck = 0; deck < 4; deck++) {
            deckGroup = this.deckGroups[deck];
            engine.makeConnection(deckGroup, 'bpm', this.bpmCallback).trigger();
            engine.makeConnection(deckGroup, 'playposition', this.positionCallback);
            engine.makeConnection(deckGroup, 'rate', this.rateCallback).trigger();

            engine.makeConnection(deckGroup, 'VuMeter', this.vuCallback).trigger();

            initPos = engine.getValue(deckGroup, "track_loaded") ? engine.getValue(deckGroup, "playposition") : 0;
            this.positionCallback(initPos, deckGroup, "playposition");

            for (control in this.genericLEDs) {
                engine.makeConnection(deckGroup, control, this.genericLEDCallback).trigger();
            }
            for (control in this.binaryLEDs) {
                engine.makeConnection(deckGroup, control, this.binaryLEDCallback).trigger();
            }

            for (padMode = 0; padMode < 6; padMode++) {
                this.updatePadModeLED(deck, padMode);
            }

            this.makePadHotcueLEDConnections(deck);
            this.makePadAutoloopLEDConnections(deck);
            this.makePadBeatjumpLEDConnections(deck);
            this.makePadSamplerLEDConnections(deck);

            this.updatePadLEDs(deck);

            this.updateRateRange(deck, this.rateRangeOptions[0]);
            this.toggleScratch(deck);
        }

        engine.beginTimer(BLINK_TIMER, this.blinkCallback, false);

        for (let fxButton = 0; fxButton < 6; fxButton++) {
            this.updateFXButtonLED(fxButton);
        }
    }

    sendSysex(buffer)
    {
        midi.sendSysexMsg(buffer, buffer.length);
    }

    encodeNumToArray(number, drop, unsigned)
    {
        let number_array = [
            (number >> 28) & 0x0F,
            (number >> 24) & 0x0F,
            (number >> 20) & 0x0F,
            (number >> 16) & 0x0F,
            (number >> 12) & 0x0F,
            (number >> 8) & 0x0F,
            (number >> 4) & 0x0F,
            number & 0x0F,
        ];

        if (drop !== "undefined") {
            number_array.splice(0, drop);
        }

        if (number < 0) {
            number_array[0] = 0x07;
        } else if (!unsigned) {
            number_array[0] = 0x08;
        }

        return number_array;
    }

    sendScreenRateMidi(deck, rate)
    {
        let rateArray = this.encodeNumToArray(rate, 2);

        let bytePrefix = [0xF0, 0x00, 0x20, 0x7F, deck, 0x02];
        let bytePostfix = [0xF7];
        let byteArray = bytePrefix.concat(rateArray, bytePostfix);
        sendSysex(byteArray);
    }

    sendScreenTimeMidi(deck, time)
    {
        let timeArray = this.encodeNumToArray(time);

        let bytePrefix = [0xF0, 0x00, 0x20, 0x7F, deck, 0x04];
        let bytePostfix = [0xF7];
        let byteArray = bytePrefix.concat(timeArray, bytePostfix);
        sendSysex(byteArray);
    }

    sendScreenBpmMidi(deck, bpm)
    {
        let bpmArray = this.encodeNumToArray(bpm, 2, true);

        let bytePrefix = [0xF0, 0x00, 0x20, 0x7F, deck, 0x01];
        let bytePostfix = [0xF7];
        let byteArray = bytePrefix.concat(bpmArray, bytePostfix);
        sendSysex(byteArray);
    }

    bpmCallback(value, group, control)
    {
        this.sendScreenBpmMidi(this.groupChannels[group]+1, value*100);
    }

    genericLEDCallback(value, group, control)
    {
        let channel = this.groupChannels[group];
        let LEDMapEntry = this.genericLEDs[control];
        midi.sendShortMsg(0x90 + channel+LEDMapEntry[0], LEDMapEntry[1], 2 + 0x7d*value);
    }

    binaryLEDCallback(value, group, control)
    {
        let channel = this.groupChannels[group];
        let LEDMapEntry = this.binaryLEDs[control];
        midi.sendShortMsg(0x90 + channel+LEDMapEntry[0], LEDMapEntry[1], value);
    }

    positionCallback(position, group, control)
    {

        let channel = this.groupChannels[group];
        let pos = Math.round(position * 52);
        if (pos < 0) {
            pos = 0;
        }
        midi.sendShortMsg(0xB0 | channel, 0x3F, pos);

        // get the current duration
        let duration = engine.getValue(group, "duration");
        let timeElapsed = duration * position;

        // update the time display
        this.sendScreenTimeMidi(channel+1, Math.round(timeElapsed * 1000));

        // update the spinner (range 64-115, 52 values)
        //
        // the visual spinner in the mixxx interface takes 1.8 seconds to loop
        // (60 seconds/min divided by 33 1/3 revolutions per min)
        let period = 60 / (33+1/3);
        let midiResolution = 52; // the controller expects a value range of 64-115
        let spinner = Math.round(timeElapsed % period * (midiResolution / period));
        if (spinner < 0) {
            spinner += 115;
        } else {
            spinner += 64;
        }

        midi.sendShortMsg(0xB0 | channel, 0x06, spinner);
    }

    rateCallback(rate, group, control)
    {
        let channel = this.groupChannels[group];
        let rateEffective = engine.getValue(group, "rateRange") * rate;
        this.sendScreenRateMidi(channel+1, (rateEffective*10000).toFixed(1));
    }

    cycleRateRange(channel, control, value, status, group)
    {
        let currRangeIdx = this.deckRateRangeIdxs[channel];
        let newRangeIdx = (currRangeIdx + 1) % this.rateRangeOptions.length;
        this.deckRateRangeIdxs[channel] = newRangeIdx;
        let newRange = this.rateRangeOptions[newRangeIdx];
        this.updateRateRange(channel, newRange);
    }

    updateRateRange(channel, range)
    {
        let group = this.deckGroups[channel];
        engine.setParameter(group, "rateRange", (range-0.01)*0.25);
        midi.sendShortMsg(0x90+channel, 0x0e, range*100);
    }

    beatloopToggle(channel, control, value, status, group)
    {
        if (engine.getParameter(group, "loop_enabled")) {
            engine.setParameter(group, "reloop_toggle", 1);
        } else {
            engine.setParameter(group, "beatloop_activate", 1);
        }
    }

    shift(channel, control, value, status, group)
    {
        this.shifted = value == 0x7f;
    }

    toggleScratch(channel, control, value, status, group)
    {
        this.deckScratchModes[channel] = !this.deckScratchModes[channel];
        midi.sendShortMsg(0x90+channel, 0x07, this.deckScratchModes[channel] ? 0x7f : 0x00);
    }

    wheelStopCheck(deck)
    {
        if (this.deckLastScratchTicks[deck] > 2
            || this.deckLastScratchTicks[deck] < -1) {
            this.deckLastScratchTicks[deck] = 0;
        } else {
            if (this.deckScratchStates[deck] == 1) {
                engine.scratchDisable(deck+1, true);
            }
            this.deckScratchStates[deck] = 0;
            engine.stopTimer(this.deckWheelStopTimers[deck]);
            this.deckWheelStopTimers[deck] = 0;
            this.deckFastSeekAccums[deck] = 0;
        }
    }

    touchWheel(channel, control, value, status, group)
    {
        // Scratch parameters
        let rpm = 33 + 1 / 3;
        let alpha = 1.0 / 8;
        let beta = alpha / 32;
        let intervalsPerRev = 1000;

        if (value == 0x7f) {
            if (this.deckWheelStopTimers[channel]) {
                engine.stopTimer(this.deckWheelStopTimers[channel]);
                this.deckWheelStopTimers[channel] = 0;
            }
            if (this.shifted) {
                // fast seek mode
                this.deckScratchStates[channel] = 2;
            } else if (this.deckScratchModes[channel] || !engine.getValue(group, "play")) {
                // scratch mode
                this.deckScratchStates[channel] = 1;
                engine.scratchEnable(channel+1, intervalsPerRev, rpm, alpha, beta);
            }
        } else {
            this.deckWheelStopTimers[channel] = engine.beginTimer(20, function() {
                this.wheelStopCheck(channel);
            }, false);
        }
    }

    jog(channel, control, value, status, group)
    {
        let amount = value > 63 ? value - 128 : value;
        this.deckLastScratchTicks[channel] = amount;
        if (this.deckScratchStates[channel] == 1) {
            engine.scratchTick(channel+1, amount);
        } else if (this.deckScratchStates[channel] == 2 || this.shifted) {
            this.deckFastSeekAccums[channel] += amount;
            if (Math.abs(this.deckFastSeekAccums[channel]) > this.fastSeekJogTicks) {
                let seekAmount = Math.floor(Math.abs(this.deckFastSeekAccums[channel])/this.fastSeekJogTicks);
                let seekDir = this.deckFastSeekAccums[channel] < 0 ? -1 : 1;
                engine.setValue(group, "beatjump", this.fastSeekRate*seekAmount*seekDir);
                this.deckFastSeekAccums[channel] -= seekAmount*seekDir*this.fastSeekJogTicks;
            }
        } else {
            let gammaInputRange = 13; // Max jog speed
            let maxOutFraction = 0.8; // Where on the curve it should peak; 0.5 is half-way
            let sensitivity = 0.5; // Adjustment gamma
            let gammaOutputRange = 0.75; // Max rate change

            let nudge = (amount < 0 ? -1 : 1) * gammaOutputRange * Math.pow(
                Math.abs(amount) / (gammaInputRange * maxOutFraction),
            );

            engine.setValue(group, "jog", nudge);
        }
    }

    loadTrack(channel, control, value, status, group)
    {
        if (value == 0x7f) {
            if (this.shifted) {
                let otherDeck = this.activeDecks[1-(this.groupChannels[group]%2)];
                engine.setValue(group, "CloneFromDeck", 1+otherDeck);
            } else {
                if (this.instantDoubles) {
                    this.instantDoubles = false;
                    engine.stopTimer(this.instantDoublesTimeoutID);
                    let otherDeck = this.activeDecks[1-(this.groupChannels[group]%2)];
                    engine.setValue(this.deckGroups[otherDeck], "LoadSelectedTrack", 1);
                } else {
                    engine.setValue(group, "LoadSelectedTrack", 1);
                    this.instantDoubles = true;
                    this.instantDoublesTimeoutID = engine.beginTimer(500, this.instantDoublesTimeout, true);
                }
            }
        }
    }

    switchActiveDeck(channel, control, value, status, group)
    {
        this.activeDecks[channel%2] = channel;
    }

    vuCallback(value, group, control)
    {
        let channel = this.groupChannels[group];
        let level = Math.round(value*80);
        if (engine.getValue(group, "PeakIndicator")) {
            level = 81;
        }
        midi.sendShortMsg(0xb0+channel, 0x1f, level);
    }

    instantDoublesTimeout()
    {
        this.instantDoubles = false;
    }

    getHotcueActivateCallback(channel, pad)
    {
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 0) {
                let brightness = value ? 0x7f : engine.getValue(group, 'hotcue_'+(pad+1)+'_enabled')*0x02;
                midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
            }
        };
    }

    getHotcueEnabledCallback(channel, pad)
    {
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 0) {
                let brightness = value*0x02;
                if (!engine.getValue(group, 'hotcue_'+(pad+1)+'_activate')) {
                    midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
                }
                midi.sendShortMsg(0x94+channel, 0x1C+pad, brightness);
            }
        };
    }

    makePadHotcueLEDConnections(channel)
    {
        let deckGroup = this.deckGroups[channel];
        for (let pad = 0; pad < 8; ++pad) {
            let callbackActivate = this.getHotcueActivateCallback(channel, pad);
            let callbackEnabled = this.getHotcueEnabledCallback(channel, pad);
            engine.makeConnection(deckGroup, 'hotcue_'+(pad+1)+'_activate', callbackActivate);
            let connectionEnabled = engine.makeConnection(deckGroup, 'hotcue_'+(pad+1)+'_enabled', callbackEnabled);
            this.deckPadLEDConnections[channel][0].push(connectionEnabled);
        }
    };

    getLoopEnabledCallback(channel, pad)
    {
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 1) {
                let brightness = value*0x7d + 0x02;
                midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
                midi.sendShortMsg(0x94+channel, 0x1C+pad, brightness);
            }
        };
    }

    makePadAutoloopLEDConnections(channel)
    {
        let deckGroup = this.deckGroups[channel];
        let loopSize, loopEnabled, callbackEnabled, connectionEnabled;
        for (let pad = 0; pad < 8; ++pad) {
            loopSize = this.autoloopSizes[pad];
            loopEnabled = 'beatloop_'+loopSize+'_enabled';
            callbackEnabled = this.getLoopEnabledCallback(channel, pad);
            connectionEnabled = engine.makeConnection(deckGroup, loopEnabled, callbackEnabled);
            this.deckPadLEDConnections[channel][1].push(connectionEnabled);
        }
    }

    getBeatjumpCallback(channel, pad)
    {
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 2) {
                let brightness = value * 0x7d + 0x02;
                midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
            }
        };
    }

    makePadBeatjumpLEDConnections(channel)
    {
        let deckGroup = this.deckGroups[channel];
        let jumpSize, jumpControl, callback, connection;
        for (let pad = 0; pad < 16; ++pad) {
            jumpSize = pad < 8 ? this.beatjumpSizes[pad] : this.beatjumpSizesShift[pad-8];
            jumpControl = null;
            if (jumpSize < 0) {
                jumpControl = 'beatjump_'+(-jumpSize)+'_backward';
            } else {
                jumpControl = 'beatjump_'+jumpSize+'_forward';
            }
            callback = this.getBeatjumpCallback(channel, pad);
            connection = engine.makeConnection(deckGroup, jumpControl, callback);
            this.deckPadLEDConnections[channel][2].push(connection);
        }
    }

    getSamplerPlayCallback(channel, pad)
    {
        let samplerGroup = '[Sampler'+(pad+1)+']';
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 3) {
                let brightness = engine.getValue(samplerGroup, 'track_loaded') * (value*0x7d + 0x02);
                midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
                midi.sendShortMsg(0x94+channel, 0x1C+pad, brightness);
            }
        };
    }

    getSamplerLoadedCallback(channel, pad)
    {
        return function(value, group, control) {
            if (this.deckPadModes[channel] == 3) {
                let brightness = value*0x02;
                midi.sendShortMsg(0x94+channel, 0x14+pad, brightness);
                midi.sendShortMsg(0x94+channel, 0x1C+pad, brightness);
            }
        };
    }

    makePadSamplerLEDConnections(channel)
    {
        let samplerGroup, callbackPlay, callbackLoaded, connectionPlay;
        for (let pad = 0; pad < 8; ++pad) {
            samplerGroup = '[Sampler'+(pad+1)+']';
            callbackPlay = this.getSamplerPlayCallback(channel, pad);
            callbackLoaded = this.getSamplerLoadedCallback(channel, pad);
            connectionPlay = engine.makeConnection(samplerGroup, 'play', callbackPlay);
            engine.makeConnection(samplerGroup, 'track_loaded', callbackLoaded);
            this.deckPadLEDConnections[channel][3].push(connectionPlay);
        }
    }

    updatePadModeLED(channel, padMode)
    {
        let addr = this.padModeAddrs[padMode];
        let modeActive = padMode == this.deckPadModes[channel]
            || (padMode === this.altPadModes[this.deckPadModes[channel]]
                && this.blinkState);
        let brightness = modeActive*0x7d + 0x02;
        midi.sendShortMsg(0x94 + channel, addr, brightness);
    }

    blinkCallback()
    {
        this.blinkState = 1 - this.blinkState;
        let altMode;
        for (let deck = 0; deck < 4; ++deck) {
            altMode = this.altPadModes[this.deckPadModes[deck]];
            if (altMode !== undefined) {
                let brightness = this.blinkState*0x7d + 0x02;
                midi.sendShortMsg(0x94+deck, this.padModeAddrs[altMode], brightness);
            }
        }
        this.updateFXButtonLED(this.activeFXSlot);
    }

    updatePadLEDs(deck)
    {
        let padMode = this.deckPadModes[deck];
        for (let i = 0; i < this.deckPadLEDConnections[deck][padMode].length; ++i) {
            this.deckPadLEDConnections[deck][padMode][i].trigger();
        }
    }

    switchPadMode(channel, control, value, status, group)
    {
        let deck = channel - 4;
        let oldPadMode = this.deckPadModes[deck];
        let oldAltPadMode = this.altPadModes[oldPadMode];
        let newPadMode = this.padModeMap[control];
        this.deckPadModes[deck] = newPadMode;
        this.updatePadModeLED(deck, oldPadMode);
        if (oldAltPadMode !== undefined) {
            this.updatePadModeLED(deck, oldAltPadMode);
        }
        this.updatePadModeLED(deck, newPadMode);
        this.updatePadLEDs(deck);
    }

    hotcuePad(channel, pad, value)
    {
        engine.setValue(this.deckGroups[channel], 'hotcue_'+(pad+1)+'_activate', value);
    }

    hotcuePadShifted(channel, pad, value)
    {
        engine.setValue(this.deckGroups[channel], 'hotcue_'+(pad+1)+'_clear', value);
    }

    autoloopPad(channel, pad, value)
    {
        engine.setValue(this.deckGroups[channel], 'beatloop_'+this.autoloopSizes[pad]+'_toggle', value);
    }
    autoloopPadShifted(channel, pad, value)
    {
        engine.setValue(this.deckGroups[channel], 'beatlooproll_'+this.autoloopSizes[pad]+'_activate', value);
    }

    beatjumpPad(channel, pad, value)
    {
        let amount = this.beatjumpSizes[pad];
        if (amount < 0) {
            engine.setValue(this.deckGroups[channel], 'beatjump_'+(-amount)+'_backward', value);
        } else {
            engine.setValue(this.deckGroups[channel], 'beatjump_'+amount+'_forward', value);
        }
    }

    beatjumpPadShifted(channel, pad, value)
    {
        let amount = this.beatjumpSizesShift[pad];
        if (amount < 0) {
            engine.setValue(this.deckGroups[channel], 'beatjump_'+(-amount)+'_backward', value);
        } else {
            engine.setValue(this.deckGroups[channel], 'beatjump_'+amount+'_forward', value);
        }
    }

    samplerPad(channel, pad, value)
    {
        engine.setValue('[Sampler'+(pad+1)+']', 'start_play', value);
    }

    pad(channel, control, value, status, group)
    {
        let deck = channel - 4;
        let pad = control - 0x14;
        value = value == 0x7f ? 1 : 0;
        if (pad < 8) {
            this.padFunctions[this.deckPadModes[deck]](deck, pad, value);
        } else {
            this.padFunctionsShifted[this.deckPadModes[deck]](deck, pad-8, value);
        }
    }

    fxBeatsCallbackDefault(effectGroup, knobInput)
    {
        let oldValue = engine.getParameter(effectGroup, 'parameter1');
        let newValue = knobInput == 0x01 ? oldValue+0.125 : oldValue-0.125;
        engine.setParameter(effectGroup, 'parameter1', newValue);
    }

    fxBeatsCallbackBitcrush(effectGroup, knobInput)
    {
    }

    getActiveEffectUnitGroup()
    {
        return "[EffectRack1_EffectUnit"+(this.activeFXSlot < 3 ? 1 : 2)+']';
    }

    getActiveEffectGroup()
    {
        return "[EffectRack1_EffectUnit"+(this.activeFXSlot < 3 ? 1 : 2)+"_Effect"+((this.activeFXSlot % 3) + 1)+']';
    }

    fxMeta(channel, control, value, status, group)
    {
        let effectUnitGroup = this.getActiveEffectUnitGroup();
        let currVal = engine.getValue(effectUnitGroup, 'super1');
        let newVal = value/128;
        let spread = Math.abs(currVal-newVal);
        if (this.fxMetaTakeover || spread < 0.07) {
            engine.setValue(effectUnitGroup, 'super1', newVal);
            this.fxMetaTakeover = true;
        }
    }

    fxBeats(channel, control, value, status, group)
    {
        let effectGroup = this.getActiveEffectGroup();
        if (engine.getValue(effectGroup, 'loaded')) {
            this.fxBeatsCallbacks[this.fxModes[this.activeFXSlot]](effectGroup, value);
        }
    }

    fxButton(channel, control, value, status, group)
    {
        if (value == 0x7f) {
            if (this.shifted) {
                let oldFXSlot = this.activeFXSlot;
                let oldUnit = this.getActiveEffectUnitGroup();
                this.activeFXSlot = control;
                let newUnit = this.getActiveEffectUnitGroup();
                if (newUnit != oldUnit) {
                    this.fxMetaTakeover = false;
                }
                this.updateFXButtonLED(oldFXSlot);
                if (this.fxModes[oldFXSlot] != -1) {
                    this.updateFXButtonLED(this.fxModes[oldFXSlot]);
                }
                this.updateFXButtonLED(this.activeFXSlot);
                if (this.fxModes[this.activeFXSlot] != -1) {
                    this.updateFXButtonLED(this.fxModes[this.activeFXSlot]);
                }
            } else {
                let effectGroup = this.getActiveEffectGroup();
                engine.setValue(effectGroup, 'clear', 1);
                engine.setValue(effectGroup, 'enabled', 0);
                let oldMode = this.fxModes[this.activeFXSlot];
                let newMode = (oldMode == control) ? -1 : control;
                this.fxModes[this.activeFXSlot] = newMode;
                if (oldMode != -1) {
                    this.updateFXButtonLED(oldMode);
                }
                if (newMode != -1) {
                    this.updateFXButtonLED(newMode);
                    for (let i = 0; i < this.fxModeMap[newMode]; ++i) {
                        engine.setValue(effectGroup, 'next_effect', 1);
                    }
                    engine.setValue(effectGroup, 'enabled', 1);
                }
            }
        }
    }

    fxPaddle(channel, control, value, status, group)
    {
        let deck = this.activeDecks[channel-0x08];
        engine.setValue(this.getActiveEffectUnitGroup(), 'group_[Channel'+(deck+1)+']_enable', value==0x00 ? 0 : 1);
    }

    updateFXButtonLED(button)
    {
        let status = 0x90 + (button < 3 ? 8 : 9);
        let value = 0x00;

        if (this.fxModes[this.activeFXSlot] == button) {
            value = 0x7f;
        } else if (this.activeFXSlot == button && this.blinkState) {
            value = 0x03;
        } else if (this.fxModes[button] != -1) {
            value = 0x01;
        }
        midi.sendShortMsg(status, button, value);
    }

    init(id, debug)
    {
    }

    shutdown()
    {
    }
}

MixtrackPlatinumFX = new MixtrackFX();
