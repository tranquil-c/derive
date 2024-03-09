// This file is adapted from taterbase/gpx-parser
//
// https://github.com/taterbase/gpx-parser
//
// See https://www.topografix.com/gpx/1/1 for details on the schema for
// GPX files.

import { XMLParser } from 'fast-xml-parser';
import FitParser from 'fit-file-parser';
import { strFromU8 } from 'fflate';;

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    attributesGroupName: '$',
});

const fitParser = new FitParser({
    force: true,
    mode: 'list',
});

function getSport(sport, name) {
    sport = sport?.toLowerCase();

    if (!sport)
    {
        if (/-(Hike|Walk)\.gpx/.test(name) || name.startsWith('Walking')) {
            sport = 'walking';
        } else if (/-Run\.gpx/.test(name) || name.startsWith('Running')) {
            sport = 'running';
        } else if (/-Ride\.gpx/.test(name) || name.startsWith('Cycling')) {
            sport = 'cycling';
        } else {
            sport = 'other';
        }
    }
    else
    {
        if (sport === 'biking')
        {
            sport = 'cycling';
        }
    }

    return sport;
}

function extractGPXTracks(gpx) {
    if (!gpx.trk && !gpx.rte) {
        console.log('GPX file has neither tracks nor routes!', gpx);
        throw new Error('Unexpected gpx file format.');
    }

    const parsedTracks = [];

    if (gpx.trk) {
        const tracks = [].concat(gpx.trk ?? []);
        tracks.forEach(trk => {
            let name = (Array.isArray(trk.name) ? trk.name[0] : trk.name) ?? 'untitled';
            let sport = getSport(undefined, name);
            let timestamp;

            const trackSegments = [].concat(trk.trkseg ?? []);
            trackSegments.forEach(trkseg => {
                let points = [];
                const trackpoints = [].concat(trkseg.trkpt ?? []);
                for (let trkpt of trackpoints) {
                    if (trkpt.time && typeof trkpt.time === 'string') {
                        timestamp = new Date(trkpt.time);
                    }
                    if (typeof trkpt.$ !== 'undefined' &&
                        typeof trkpt.$.lat !== 'undefined' &&
                        typeof trkpt.$.lon !== 'undefined') {
                        points.push({
                            lat: parseFloat(trkpt.$.lat),
                            lng: parseFloat(trkpt.$.lon),
                            timestamp: timestamp,
                            // These are available to us, but are currently unused
                            // elev: parseFloat(trkpt.ele) || 0,
                        });
                    }
                }

                if (points.length > 0) {
                    parsedTracks.push({timestamp, points, name, sport});
                }
            });
        });
    }

    if (gpx.rte) {
        const routes = [].concat(gpx.rte ?? []);
        routes.forEach(rte => {
            let name = (Array.isArray(rte.name) ? rte.name[0] : rte.name) ?? 'untitled';
            let timestamp;
            let points = [];
            const routepoints = [].concat(rte.rtept ?? []);
            for (let pt of routepoints) {
                if (pt.time && typeof pt.time === 'string') {
                    timestamp = new Date(pt.time);
                }
                points.push({
                    lat: parseFloat(pt.$.lat),
                    lng: parseFloat(pt.$.lon),
                });
            }

            if (points.length > 0) {
                parsedTracks.push({timestamp, points, name, sport: 'other'});
            }
        });
    }

    return parsedTracks;
}

function extractTCXTracks(tcx, name) {
    if (!tcx.Activities) {
        console.log('TCX file has no activities!', tcx);
        throw new Error('Unexpected tcx file format.');
    }

    const parsedTracks = [];
    const activities = [].concat(tcx.Activities.Activity ?? []);
    for (const act of activities) {
        let sport = act.$.Sport;
        if (sport === 'Other')
        {
            sport = act.Training?.Plan.Name;
        }
        sport = getSport(sport, name);

        const laps = [].concat(act.Lap ?? []);
        for (const lap of laps) {
            if (!lap.Track) {
                continue;
            }

            const tracks = [].concat(lap.Track ?? []);
            for (const track of tracks)
            {
                const trackPoints = [].concat(track.Trackpoint ?? []).filter(it => it.Position);
                let timestamp;
                let points = []

                for (let trkpt of trackPoints) {
                    if (trkpt.Time && typeof trkpt.Time === 'string') {
                        timestamp = new Date(trkpt.Time);
                    }
                    points.push({
                        lat: parseFloat(trkpt.Position.LatitudeDegrees),
                        lng: parseFloat(trkpt.Position.LongitudeDegrees),
                        timestamp: timestamp,
                        // These are available to us, but are currently unused
                        // elev: parseFloat(trkpt.ElevationMeters[0]) || 0,
                    });
                }

                if (points.length > 0) {
                    parsedTracks.push({timestamp, points, name, sport});
                }
            }
        }
    }

    return parsedTracks;
}

function extractFITTracks(fit, name) {
    if (!fit.records || fit.records.length === 0) {
        console.log('FIT file has no records!', fit);
        throw new Error('Unexpected FIT file format.');
    }

    let timestamp;
    let sport = fit.sports[0]?.sport || null;
    if (!sport && fit.file_ids[0].manufacturer === 'zwift') {
        sport = 'cycling';
    }

    const points = [];
    for (const record of fit.records) {
        if (record.position_lat && record.position_long) {
            points.push({
                lat: record.position_lat,
                lng: record.position_long,
                timestamp: record.timestamp,
                // Other available fields: timestamp, distance, altitude, speed, heart_rate
            });
        }
        record.timestamp && (timestamp = record.timestamp);
    }

    return points.length > 0 ? [{timestamp, points, name, sport}] : [];
}

function extractJSONTracks(json, name) {
    const parsedTracks = [];
    for (const exercise of json.exercises)
    {
        if (!exercise.samples.recordedRoute) { continue; }
        const timestamp = new Date(exercise.startTime);
        const points = exercise.samples.recordedRoute.map((point) => ({
            lat: point.latitude,
            lng: point.longitude,
            timestamp: new Date(point.dateTime) 
        }) );
        const sport = getSport(exercise.sport, name);

        if (points.length > 0)
        {
            parsedTracks.push({timestamp, points, name, sport});
        }

    }
    return parsedTracks;
}

export default function extractTracks(name, contents) {
    const format = name.split('.').pop().toLowerCase();
    switch (format) {
        case 'gpx':
        case 'tcx':
            return new Promise((resolve, reject) => {
                const result = xmlParser.parse(strFromU8(contents));
                if (result.gpx) {
                    resolve(extractGPXTracks(result.gpx));
                } else if (result.TrainingCenterDatabase) {
                    resolve(extractTCXTracks(result.TrainingCenterDatabase, name));
                } else {
                    reject(new Error('Invalid file type.'));
                }
            });
        case 'fit':
            return new Promise((resolve, reject) => {
                fitParser.parse(contents, (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(extractFITTracks(result, name));
                    }
                });
            });
        case 'json':
            return new Promise((resolve, reject) => {
                try {
                    const json = JSON.parse(strFromU8(contents));
                    resolve(extractJSONTracks(json, name));
                }
                catch (e) {
                    reject(e);
                }
            })
        default:
            throw `Unsupported file format: ${format}`;
    }
}
