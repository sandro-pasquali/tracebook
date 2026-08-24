import {setTimeout as sleep} from 'node:timers/promises';
import {config} from './config.js';

const MIN_SLEEP_MS = 50;

// Per-session token-per-minute governor.
// Tracks a rolling 60-second window of observed token usage plus in-flight
// reservations so parallel model calls cannot all pass the same stale budget
// check.
//
export function createGovernor({budget, initialEstimate = config.governor.initialTokenGuess} = {}) {
    if(!budget || budget <= 0) {
        throw new Error('createGovernor requires a positive budget');
    }

    const entries = [];
    const reservations = new Map();
    let lastTokens = initialEstimate;
    let nextReservationId = 1;

    function trim() {
        const cutoff = Date.now() - config.governor.windowMs;
        while(entries.length > 0 && entries[0].at < cutoff) {
            entries.shift();
        }
    }

    function currentUsage() {
        trim();
        let sum = 0;
        for(const entry of entries) {
            sum += entry.tokens;
        }
        for(const reservation of reservations.values()) {
            sum += reservation.tokens;
        }
        return sum;
    }

    async function beforeCall(estimateTokens = null) {
        const estimate = estimateFor(estimateTokens);
        while(true) {
            trim();
            const used = currentUsage();
            const projected = used + estimate;
            if(projected <= budget || used === 0) {
                return reserve(estimate);
            }
            const waitMs = waitDurationMs();
            await sleep(waitMs);
        }
    }

    function afterCall(tokens, reservation = null) {
        releaseCall(reservation || oldestReservation());
        if(tokens && tokens > 0) {
            entries.push({at: Date.now(), tokens});
            lastTokens = tokens;
        }
    }

    function releaseCall(reservation = null) {
        const id = reservationId(reservation);
        if(id !== null) {
            reservations.delete(id);
        }
    }

    function snapshot() {
        trim();
        let reserved = 0;
        for(const reservation of reservations.values()) {
            reserved += reservation.tokens;
        }
        return {
            budget,
            used: currentUsage(),
            observed: currentUsage() - reserved,
            reserved,
            lastTokens,
            windowEntries: entries.length,
            inFlight: reservations.size
        };
    }

    function reserve(tokens) {
        const id = nextReservationId++;
        const reservation = {id, tokens, at: Date.now()};
        reservations.set(id, reservation);
        return reservation;
    }

    function estimateFor(value) {
        return Number.isFinite(value) && value > 0 ? value : lastTokens;
    }

    function waitDurationMs() {
        if(reservations.size > 0) {
            return MIN_SLEEP_MS;
        }
        if(entries.length === 0) {
            return MIN_SLEEP_MS;
        }
        const oldest = entries[0].at;
        return Math.max(MIN_SLEEP_MS, (oldest + config.governor.windowMs) - Date.now() + 10);
    }

    function oldestReservation() {
        const first = reservations.keys().next();
        return first.done ? null : first.value;
    }

    function reservationId(reservation) {
        if(reservation === null || reservation === undefined) {
            return null;
        }
        if(typeof reservation === 'number') {
            return reservations.has(reservation) ? reservation : null;
        }
        const id = Number(reservation.id);
        return Number.isInteger(id) && reservations.has(id) ? id : null;
    }

    return {beforeCall, afterCall, releaseCall, snapshot};
}
