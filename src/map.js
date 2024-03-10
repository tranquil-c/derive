import leaflet from 'leaflet';
import leafletImage from 'leaflet-image';
import 'leaflet-providers';
import 'leaflet-sidebar-v2';

import { search } from './util';
import * as ui from './ui';
import Tablesort from 'tablesort';

(function(){
    let cleanNumber = function(i) {
      return i.replace(/[^\-?0-9.]/g, '');
    },
  
    compareNumber = function(a, b) {
      a = parseFloat(a);
      b = parseFloat(b);
  
      a = isNaN(a) ? 0 : a;
      b = isNaN(b) ? 0 : b;
  
      return a - b;
    };
  
    Tablesort.extend('number', function(item) {
      return item.match(/^[-+]?[£\x24Û¢´€]?\d+\s*([,\.]\d{0,2})/) || // Prefixed currency
        item.match(/^[-+]?\d+\s*([,\.]\d{0,2})?[£\x24Û¢´€]/) || // Suffixed currency
        item.match(/^[-+]?(\d)*-?([,\.]){0,1}-?(\d)+([E,e][\-+][\d]+)?%?$/); // Number
    }, function(a, b) {
      a = cleanNumber(a);
      b = cleanNumber(b);
  
      return compareNumber(b, a);
    });
  }());

// Los Angeles is the center of the universe
const INIT_COORDS = [34.0522, -118.243];


const DEFAULT_OPTIONS = {
    theme: 'CartoDB.DarkMatter',
    lineOptions: {
        color: '#0CB1E8',
        weight: 3,
        opacity: 0.25,
        smoothFactor: 1,
        overrideExisting: true,
        colorMode: 'detectColors',
    },
    markerOptions: {
        color: '#00FF00',
        weight: 3,
        radius: 5,
        opacity: 0.5
    },
    animationOptions: {
        playbackRate: 300,
        mode: 'simultaneous'
    }
};


export default class GpxMap {
    constructor(options) {
        this.options = options || DEFAULT_OPTIONS;
        this.tracks = [];
        this.filters = {
            minDate: null,
            maxDate: null,
            showCycling: true,
            showRunning: true,
            showOther: true
        };
        this.imageMarkers = [];

        this.map = leaflet.map('background-map', {
            center: INIT_COORDS,
            zoom: 10,
            preferCanvas: true,
        });

        this.trackAnimationFrame = undefined;

        let fillStroke = leaflet.Canvas.prototype._fillStroke;
        leaflet.Canvas.prototype._fillStroke = (ctx, layer) => {
            let compositeOperation = ctx.globalCompositeOperation;
            ctx.globalCompositeOperation = 'lighten';
            fillStroke(ctx, layer);
            ctx.globalCompositeOperation = compositeOperation;
        }

        this.sidebar = leaflet.control.sidebar({
            autopan: true,
            closeButton: true,
            container: 'sidebar',
            position: 'left',
        }).addTo(this.map);

        this.sidebar.addPanel({
            id: 'export',
            tab: '<i class="fa fa-camera fa-lg"></i>',
            title: 'Export as png',
            button: () => {
                let modal = ui.showModal('exportImage')
                    .afterClose(() => modal.destroy());

                document.getElementById('render-export').onclick = (e) => {
                    e.preventDefault();

                    let output = document.getElementById('export-output');
                    output.innerHTML = 'Rendering <i class="fa fa-cog fa-spin"></i>';

                    let form = document.getElementById('export-settings').elements;
                    this.screenshot(form.format.value, output);
                };
            }
        });

        this.sidebar.updatePanel = function(data)
        {
            const tab = this._getTab(data.id);
            if (data.title && data.title[0] !== '<')  { tab.title = data.title; }
            tab.querySelector('a').innerHTML = data.tab;
            tab._button = data.button;
        };

        this.sidebar.addPanel({
            id: 'settings',
            tab: '<i class="fa fa-sliders fa-lg"></i>',
            title: 'Open settings dialog',
            button: () => {
                ui.buildSettingsModal(this.tracks, this.options, (opts) => {
                    this.updateOptions(opts);
                    this.saveOptions(opts);
                }).show();
            },
        });

        this.sidebar.addPanel({
            id: 'filters',
            tab: '<i class="fa fa-filter fa-lg"></i>',
            title: 'Filter displayed tracks',
            button: () => {
                ui.buildFilterModal(this.tracks, this.filters, (f) => {
                    this.filters = f;
                    this.applyFilters();
                }).show();
            }
        });

        this.sidebar.addPanel({
            id: 'viewall',
            tab: '<i class="fa fa-map fa-lg"></i>',
            title: 'Zoom to all tracks',
            button: () => {
                this.center();
            },
            disabled: true
        });

        this.sidebar.addPanel({
            id: 'animate',
            tab: '<i class="fa fa-play fa-lg"></i>',
            title: 'Play',
            button: () => {
                this.animateTracks()
            },
            disabled: true
        });

        this.sidebar.addPanel({
            id: 'tracklist',
            tab: '<i class="fa fa-list fa-lg"></i>',
            title: 'Activity List',
            pane: '<table id="trackList" class="sort"><thead><tr><th>Timestamp</th><th>Sport</th><th data-sort-method="number">Distance</th></tr></thead><tbody></tbody></table>'
        });

        const table = this.sidebar._container.querySelector('#trackList');
        this.sort = new Tablesort(table);
        this.trackList = table.querySelector('tbody');
        this.trackCount = 0;

        this.markScrolled = () => {
            this.map.removeEventListener('movestart', this.markScrolled);
            this.scrolled = true;
        };

        this.clearScroll();
        this.switchTheme(this.options.theme);
        this.requestBrowserLocation();
    }

    clearScroll() {
        this.scrolled = false;
        this.map.addEventListener('movestart', this.markScrolled);
    }

    switchTheme(themeName) {
        if (this.mapTiles) {
            this.mapTiles.removeFrom(this.map);
        }

        if (themeName !== 'No map') {
            this.mapTiles = leaflet.tileLayer.provider(themeName);
            this.mapTiles.addTo(this.map, {detectRetina: true});
        }
    }

    saveOptions(opts) {
        window.localStorage.setItem('options', JSON.stringify(opts));
    }

    restoreSavedOptions() {
        if (window.localStorage.getItem('options') === null) {
            return;
        }

        let opts = window.localStorage.getItem('options');
        opts = JSON.parse(opts);

        if (typeof opts === 'object') {
            this.updateOptions(opts);
        }
    }

    updateOptions(opts) {
        if (opts.theme !== this.options.theme) {
            this.switchTheme(opts.theme);
        }

        if (opts.lineOptions.overrideExisting) {
            this.tracks.forEach((track) => {
                let lineOptions = this.getLineOptions(track, opts);
                track.line.setStyle({
                    color: lineOptions.color,
                    weight: lineOptions.weight,
                    opacity: lineOptions.opacity,
                });

                track.line.redraw();
            });

            let markerOptions = opts.markerOptions;
            this.imageMarkers.forEach(i => {
                i.setStyle({
                    color: markerOptions.color,
                    weight: markerOptions.weight,
                    opacity: markerOptions.opacity,
                    radius: markerOptions.radius
                });

                i.redraw();
            });

        }

        this.options = opts;
    }

    applyFilters() {
        const dateBounds = {
            min: new Date(this.filters.minDate || '1900/01/01'),
            max: new Date(this.filters.maxDate || '2500/01/01'),
        };

        // NOTE: Tracks that don't have an associated timestamp will never be
        // excluded.
        const filters = [
            (t) => t.timestamp && dateBounds.min > t.timestamp,
            (t) => t.timestamp && dateBounds.max < t.timestamp,
        ];

        const sportFilters = [];
        if (this.filters.showCycling) { sportFilters.push((t) => t.sport && t.sport === 'cycling'); }
        if (this.filters.showRunning) { sportFilters.push((t) => t.sport && t.sport === 'running'); }
        if (this.filters.showOther) { sportFilters.push((t) => t.sport && t.sport !== 'cycling' && t.sport !== 'running'); }

        for (let track of this.tracks) {
            let hideTrack = filters.some(f => f(track));
            hideTrack |= !sportFilters.some(f => f(track));

            if (hideTrack && track.visible) {
                this.trackList.querySelector('#' + track.id).style.display = 'none';
                track.line.remove();
            } else if (!hideTrack && !track.visible){
                this.trackList.querySelector('#' + track.id).style.display = '';
                track.line.addTo(this.map);
            }

            track.visible = !hideTrack;
        }
    }

    // Try to pull geo location from browser and center the map
    requestBrowserLocation() {
        navigator.geolocation.getCurrentPosition(pos => {
            if (!this.scrolled && this.tracks.length === 0) {
                this.map.panTo([pos.coords.latitude, pos.coords.longitude], {
                    noMoveStart: true,
                    animate: false,
                });
                // noMoveStart doesn't seem to have an effect, see Leaflet
                // issue: https://github.com/Leaflet/Leaflet/issues/5396
                this.clearScroll();
            }
        });
    }

    getLineOptions(track, options = this.options) {
        let lineOptions = Object.assign({}, options.lineOptions);

        if (lineOptions.colorMode === 'detectColors') {
            if (track.sport === 'walking') {
                lineOptions.color = '#0000ff';
            } else if (track.sport === 'running') {
                lineOptions.color = '#0000ff';
            } else if (track.sport === 'cycling') {
                lineOptions.color = '#00ff00';
            } else {
                lineOptions.color = '#ff0000';
            }
        }
        else if (lineOptions.colorMode === 'highlightNew')
        {
            let newDate = new Date(options.newDate);
            if (track.timestamp > newDate)
            {
                lineOptions.color = '#00ff00';
            } else {
                lineOptions.color = '#ff0000';
            }
        }
        return lineOptions;
    }

    addTrack(track) {
        this.sidebar.enablePanel('viewall');
        this.sidebar.enablePanel('animate');
        let lineOptions = this.getLineOptions(track);

        let line = leaflet.polyline(track.points, lineOptions);
        line.addTo(this.map);

        track.line = line;
        track.visible = true;
        track.id = "t" + this.trackCount++;

        this.tracks.push(track);
        this.tracks.sort((a, b) => a.timestamp - b.timestamp);

        let tr = document.createElement('tr');
        let td = document.createElement('td');
        td = document.createElement('td');
        td.innerText = track.timestamp?.toLocaleDateString() ?? "no timestamp";
        td.setAttribute('data-sort', +track.timestamp);
        tr.appendChild(td);

        td = document.createElement('td');
        td.innerText = track.sport;
        tr.appendChild(td);

        let distance = track.distance ?? track.line.getLatLngs().reduce((acc, currPt) => {
            if (acc.lastPt) {
                return { lastPt: currPt, distance: acc.distance + currPt.distanceTo(acc.lastPt) };
            }
            return { lastPt: currPt, distance: 0 };
        }, { lastPt: undefined, distance: 0}).distance;
        distance /= 1000;

        td = document.createElement('td');
        td.innerText = distance?.toFixed(2);

        tr.id = track.id;
        tr.appendChild(td);
        
        tr.onclick = () => {
            let offset = this.sidebar._container.getBoundingClientRect().right;
            this.map.fitBounds(track.line.getBounds(), {
                paddingTopLeft: [offset, 50],
                paddingBottomRight: [50, 50]
            });
        };
        tr.onmouseover = () => {
            track.line.options.color = '#ffffff';
            track.line.options.opacity = 1;
            track.line.options.weight = lineOptions.weight * 2;
            track.line.redraw();
        }
        tr.onmouseout = () => {
            track.line.options.color = lineOptions.color;
            track.line.options.opacity = lineOptions.opacity;
            track.line.options.weight = lineOptions.weight;
            track.line.redraw();
        }
        this.trackList.appendChild(tr);
        this.sort.refresh();
        this.applyFilters();
    }

    async markerClick(image) {
        const latitude = await image.latitude();
        const longitude = await image.longitude();
        const imageData = await image.getImageData();

        let latlng = leaflet.latLng(latitude, longitude);

        leaflet.popup({minWidth: 512})
            .setLatLng(latlng)
            .setContent(`<img src="${imageData}" width="512" height="100%">`)
            .addTo(this.map);
    }

    async addImage(image) {
        const lat = await image.latitude();
        const lng = await image.longitude();

        let latlng = leaflet.latLng(lat, lng);
        let markerOptions = Object.assign({}, this.options.markerOptions);

        let marker = leaflet.circleMarker(latlng, markerOptions)
            .on('click', () => {
                this.markerClick(image);
            })
            .addTo(this.map);

        this.imageMarkers.push(marker);
    }

    // Center the map if the user has not yet manually panned the map
    recenter() {
        if (!this.scrolled) {
            this.center();
        }
    }

    center() {
        // If there are no tracks, then don't try to get the bounds, as there
        // would be an error
        let visibleTracks = this.tracks.filter(t => t.visible);
        if (visibleTracks.length === 0 && this.imageMarkers.length === 0) {
            return;
        }

        let tracksAndImages = visibleTracks.map(t => t.line)
            .concat(this.imageMarkers);

        let offset = this.sidebar._container.getBoundingClientRect().right;
        this.map.fitBounds((new leaflet.featureGroup(tracksAndImages)).getBounds(), {
            noMoveStart: true,
            animate: false,
            paddingTopLeft: [offset, 50],
            paddingBottomRight: [50, 50],
        });

        if (!this.scrolled) {
            this.clearScroll();
        }
    }

    animateTracks()
    {
        this.sidebar.updatePanel({
            id: 'animate',
            tab: '<i class="fa fa-stop fa-lg"></i>',
            title: 'Stop',
            button: () => {
                this.stopAnimation()
            }
        });

        const animationMode = this.options.animationOptions.mode
        let visibleTracks = this.tracks.filter(t => t.visible);
        if (visibleTracks.length === 0 && this.imageMarkers.length === 0) {
            return;
        }
        if (animationMode === 'latest')
        {
            visibleTracks = [visibleTracks.at(-1)];
        }

        let minBound, maxBound;

        if (animationMode === 'simultaneous' || animationMode === 'latest')
        {
            minBound = 0;
            maxBound = Math.max(...visibleTracks.map(t => t.points[t.points.length - 1].timestamp - t.points[0].timestamp));
        }
        else if (animationMode === 'synchronized')
        {
            minBound = +Math.min(...visibleTracks.map(t => t.points.at(0).timestamp));
            maxBound = +Math.max(...visibleTracks.map(t => t.points.at(-1).timestamp));
        }

        let start, previousTimeStamp = 0;

        const animate = step.bind(this);

        function step(timestamp)
        {
            if (start === undefined)
            {
                start = timestamp;
            }
            const elapsed = timestamp - start;
            const stepTime = minBound + (elapsed * this.options.animationOptions.playbackRate);

            if (previousTimeStamp === 0)
            {
                for (const track of (visibleTracks))
                {
                    track.line.setLatLngs([]);
                }
            }

            if (previousTimeStamp !== timestamp)
            {
                for (const track of visibleTracks)
                {
                    const trackStepTime = stepTime + (animationMode === 'synchronized' ? 0 : +track.points[0].timestamp);

                    let i = search(track.points, trackStepTime, (pt, target) => pt.timestamp - target);
                    if (i < 0) { i = ~i; }

                    if (i > 0 && i < track.points.length)
                    {
                        const point = track.points[i-1];
                        if (track.marker)
                        {
                            track.marker.setLatLng(point);
                            track.line.addLatLng(point);
                        }
                        else
                        {
                            track.marker = leaflet.circleMarker(point, { color: '#3388ff', fill: true, fillOpacity: 0.5, pane: 'markerPane' });
                            track.marker.addTo(this.map);
                            track.line.addLatLng(point);
                        }
                    }
                    if (i >= track.points.length)
                    {
                        track.marker?.remove();
                        delete track.marker;
                    }
                }
            }

            if (stepTime < maxBound)
            {
                previousTimeStamp = timestamp;
                this.trackAnimationRequest = window.requestAnimationFrame(animate);
            }
            else
            {
                this.cleanupAnimation();
            }
        }

        this.trackAnimationRequest = window.requestAnimationFrame(animate);
    }

    stopAnimation()
    {
        window.cancelAnimationFrame(this.trackAnimationRequest);
        this.cleanupAnimation();
    }

    cleanupAnimation()
    {
        this.sidebar.updatePanel({
            id: 'animate',
            tab: '<i class="fa fa-play fa-lg"></i>',
            title: 'Play',
            button: () => {
                this.animateTracks()
            }
        });

        this.tracks.forEach(track => {
            track.marker?.remove();
            delete track.marker;
            track.line.setLatLngs(track.points);
        })
    }

    screenshot(format, domNode) {
        leafletImage(this.map, (err, canvas) => {
            if (err) {
                return window.alert(err);
            }

            let link = document.createElement('a');

            if (format === 'png') {
                link.download = 'derive-export.png';
                link.innerText = 'Download as PNG';

                canvas.toBlob(blob => {
                    link.href = URL.createObjectURL(blob);
                    domNode.innerText = '';
                    domNode.appendChild(link);
                });
            } else if (format === 'svg') {
                link.innerText = 'Download as SVG';

                const scale = 2;
                const bounds = this.map.getPixelBounds();
                bounds.min = bounds.min.multiplyBy(scale);
                bounds.max = bounds.max.multiplyBy(scale);
                const left = bounds.min.x;
                const top = bounds.min.y;
                const width = bounds.getSize().x;
                const height = bounds.getSize().y;

                let svg = leaflet.SVG.create('svg');
                let root = leaflet.SVG.create('g');

                svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

                this.tracks.forEach(track => {
                    // Project each point from LatLng, scale it up, round to
                    // nearest 1/10 (by multiplying by 10, rounding and
                    // dividing), and reducing by removing duplicates (when two
                    // consecutive points have rounded to the same value)
                    let pts = track.points.map(ll =>
                            this.map.project(ll)
                                    .multiplyBy(scale*10)
                                    .round()
                                    .divideBy(10)
                    ).reduce((acc,next) => {
                        if (acc.length === 0 ||
                                acc[acc.length-1].x !== next.x ||
                                acc[acc.length-1].y !== next.y) {
                            acc.push(next);
                        }
                        return acc;
                    }, []);

                    // If none of the points on the track are on the screen,
                    // don't export the track
                    if (!pts.some(pt => bounds.contains(pt))) {
                        return;
                    }
                    let path = leaflet.SVG.pointsToPath([pts], false);
                    let el = leaflet.SVG.create('path');

                    el.setAttribute('stroke', track.line.options.color);
                    el.setAttribute('stroke-opacity', track.line.options.opacity);
                    el.setAttribute('stroke-width', scale * track.line.options.weight);
                    el.setAttribute('stroke-linecap', 'round');
                    el.setAttribute('stroke-linejoin', 'round');
                    el.setAttribute('fill', 'none');

                    el.setAttribute('d', path);

                    root.appendChild(el);
                });

                svg.appendChild(root);

                let xml = (new XMLSerializer()).serializeToString(svg);
                link.download = 'derive-export.svg';

                let blob = new Blob([xml], {type: 'application/octet-stream'});
                link.href = URL.createObjectURL(blob);

                domNode.innerText = '';
                domNode.appendChild(link);
            }
        });
    }
}
