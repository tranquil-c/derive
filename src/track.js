// This file is adapted from taterbase/gpx-parser
//
// https://github.com/taterbase/gpx-parser
//
// See https://www.topografix.com/gpx/1/1 for details on the schema for
// GPX files.

import { XMLParser } from 'fast-xml-parser';
import FitParser from 'fit-file-parser';
import Pako from 'pako';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    attributesGroupName: '$',
});

function extractGPXTracks(gpx) {
    if (!gpx.trk && !gpx.rte) {
        console.log('GPX file has neither tracks nor routes!', gpx);
        throw new Error('Unexpected gpx file format.');
    }

    const parsedTracks = [];

    if (gpx.trk) {
        const tracks = [].concat(gpx.trk ?? []);
        tracks.forEach(trk => {
            let name = trk.name && trk.name.length > 0 ? trk.name[0] : 'untitled';
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
                            // These are available to us, but are currently unused
                            // elev: parseFloat(trkpt.ele) || 0,
                        });
                    }
                }

                if (points.length > 0) {
                    parsedTracks.push({timestamp, points, name});
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
                parsedTracks.push({timestamp, points, name});
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
    let sport = fit.sport && fit.sport.sport || null;
    if (!sport && fit.file_id.manufacturer === 'zwift') {
        sport = 'cycling';
    }

    const points = [];
    for (const record of fit.records) {
        if (record.position_lat && record.position_long) {
            points.push({
                lat: record.position_lat,
                lng: record.position_long,
                // Other available fields: timestamp, distance, altitude, speed, heart_rate
            });
        }
        record.timestamp && (timestamp = record.timestamp);
    }

    return points.length > 0 ? [{timestamp, points, name, sport}] : [];
}

function readFile(file, encoding, isGzipped) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const result = e.target.result;
            try {
                return resolve(isGzipped ? Pako.inflate(result) : result);
            } catch (e) {
                return reject(e);
            }
        };

        if (encoding === 'binary') {
            reader.readAsArrayBuffer(file);
        } else {
            reader.readAsText(file);
        }
    });
}

export default function extractTracks(file) {
    const isGzipped = /\.gz$/i.test(file.name);
    const strippedName = file.name.replace(/\.gz$/i, '');
    const format = strippedName.split('.').pop().toLowerCase();

    switch (format) {
    case 'gpx':
    case 'tcx': /* Handle XML based file formats the same way */

        return readFile(file, 'text', isGzipped)
            .then(textContents => new Promise((resolve, reject) => {
                const result = parser.parse(textContents);
                if (result.gpx) {
                    resolve(extractGPXTracks(result.gpx));
                } else if (result.TrainingCenterDatabase) {
                    resolve(extractTCXTracks(result.TrainingCenterDatabase, strippedName));
                } else {
                    reject(new Error('Invalid file type.'));
                }
            }));

    case 'fit':
        return readFile(file, 'binary', isGzipped)
            .then(contents => new Promise((resolve, reject) => {
                const parser = new FitParser({
                    force: true,
                    mode: 'list',
                });

                parser.parse(contents, (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(extractFITTracks(result, strippedName));
                    }
                });
            }));

    default:
        throw `Unsupported file format: ${format}`;
    }
}
