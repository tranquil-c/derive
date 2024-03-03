import picoModal from 'picomodal';
import extractTracks from './track';
import Image from './image';
import { unzipSync } from 'fflate';

const AVAILABLE_THEMES = [
    'CartoDB.DarkMatter',
    'CartoDB.DarkMatterNoLabels',
    'CartoDB.Positron',
    'CartoDB.PositronNoLabels',
    'Esri.WorldImagery',
    'OpenStreetMap.Mapnik',
    'OpenTopoMap',
    'Stamen.Terrain',
    'Stamen.TerrainBackground',
    'Stamen.Toner',
    'Stamen.TonerLite',
    'Stamen.TonerBackground',
    'Stamen.Watercolor',
    'CyclOSM',
    'No map',
];

const MODAL_CONTENT = {
    help: `
<h1>dérive</h1>
<h4>Drag and drop one or more GPX/TCX/FIT files or JPEG images here.</h4>
<p>If you use Strava, go to your
<a href="https://www.strava.com/athlete/delete_your_account">account download
page</a> and click "Request your archive". You'll get an email containing a ZIP
file of all the GPS tracks you've logged so far. This can take several hours.
</p>

<p>All processing happens in your browser. Your files will not be uploaded or
stored anywhere.</p>

<blockquote>
In a dérive one or more persons during a certain period drop their
relations, their work and leisure activities, and all their other
usual motives for movement and action, and let themselves be drawn by
the attractions of the terrain and the encounters they find there.<cite><a
href="http://library.nothingness.org/articles/SI/en/display/314">[1]</a></cite>
</blockquote>

<p>Code is available <a href="https://github.com/erik/derive">on GitHub</a>.</p>
`,

    exportImage: `
<h3>Export Image</h3>

<form id="export-settings">
    <div class="form-row">
        <label>Format:</label>
        <select name="format">
            <option selected value="png">PNG</option>
            <option value="svg">SVG (no background map)</option>
        </select>
    </div>

    <div class="form-row">
        <label></label>
        <input id="render-export" type="button" value="Render">
    </div>
</form>

<p id="export-output"></p>
`
};

// Adapted from: http://www.html5rocks.com/en/tutorials/file/dndfiles/
function handleFileSelect(map, evt) {
    evt.stopPropagation();
    evt.preventDefault();

    let tracks = [];
    let items = Array.from(evt.dataTransfer.items);
    let modal = buildUploadModal(items.length);

    modal.show();

    const handleImage = async file => {
        const image = new Image(file);
        const hasGeolocationData = await image.hasGeolocationData();
        if (!hasGeolocationData) { throw 'No geolocation data'; }
        await map.addImage(image);
        modal.addSuccess();
    };

    const handleTrackFile = async (file, contents) => {
        if (file.endsWith('.zip'))
        {
            return handleZip(contents);
        }

        const extractedTracks = await extractTracks(file, contents);
        if (extractedTracks.length > 0) {
            const track = extractedTracks.reduce((ts, t) => { ts.points = ts.points.concat(t.points); return ts; })
            track.filename = file;
            tracks.push(track);
            map.addTrack(track);
        }
        modal.addSuccess();
    };

    async function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = e.target.result;
                try {
                    return resolve(result);
                } catch (e) {
                    return reject(e);
                }
            };

            reader.readAsArrayBuffer(file);    
        });
    }

    function fileFilter(fileInfo) {
        const name = fileInfo.name;
        return name.endsWith('.fit') 
            || name.endsWith('.tcx')
            || name.endsWith('.gpx')
            || name.endsWith('.zip')
            || (name.endsWith('.json') && name.startsWith('training-session'));    
    }

    function unzip(bytes) {
        let data = unzipSync(new Uint8Array(bytes), { filter: fileFilter });
        return data;
    }

    const handleZipEntry = async entry =>
    {
        return new Promise((resolve) => setTimeout(resolve, 0))
            .then(() => handleTrackFile(...entry));
    };

    const handleZip = async (contents) => {
        const unzipped = unzip(contents);
        modal.addDirectoryEntries(Object.keys(unzipped).length);
        return Promise.all(Object.entries(unzipped).map(handleZipEntry));
    }

    const handleFile = async file => {
        try {
            if (/\.jpe?g$/i.test(file.name)) {
                return await handleImage(file);
            }
            if (/\.zip$/i.test(file.name)) {
                return await readFile(file).then((contents) => handleZip(contents));
            }
            return await readFile(file).then((contents) => handleTrackFile(file.name, contents));
        } catch (err) {
            console.error(err);
            modal.addFailure({name: file.name, error: err});
        }
    };

    const readEntries = async reader => {
        return new Promise(resolve => {
            reader.readEntries(resolve);
        })
    }

    const readAllEntries = async reader => {
        const entries = [];
        let newEntries;
        do
        {
            newEntries = await readEntries(reader);
            entries.push(...newEntries);
        } while (newEntries.length > 0);
        return entries;
    }

    const handleDirectory = async dir => {
        const reader = dir.createReader();
        return await readAllEntries(reader).then(async contents => {
            modal.addDirectoryEntries(contents.length);
            return Promise.all(contents.map(handleEntry))
        });
    };

    const resolveFile = async entry => {
        return new Promise((resolve, reject) => {
            entry.file(resolve, reject);
        });
    };

    const handleEntry = async entry =>
    {
        if (entry.isFile)
        {
            return await resolveFile(entry).then(handleFile);
        }
        else if (entry.isDirectory)
        {
            return await handleDirectory(entry);
        }
    }

    Promise.all(items.map(item => handleEntry(item.webkitGetAsEntry()))).then(() => {
        map.center();
        modal.finished();
    });
}


function handleDragOver(evt) {
    evt.dataTransfer.dropEffect = 'copy';
    evt.stopPropagation();
    evt.preventDefault();
}


function buildUploadModal(numFiles) {
    let numLoaded = 0;
    let failures = [];
    let failureString = failures.length ? `, <span class='failures'>${failures.length} failed</span>` : '';
    let getModalContent = () => `
        <h1>Reading files...</h1>
        <p>${numLoaded} loaded${failureString} of <b>${numFiles}</b></p>`;

    let modal = picoModal({
        content: getModalContent(),
        escCloses: false,
        overlayClose: false,
        overlayStyles: styles => {
            styles.opacity = 0.1;
        },
    });

    modal.afterCreate(() => {
        // Do not allow the modal to be closed before loading is complete.
        // PicoModal does not allow for native toggling
        modal.closeElem().style.display = 'none';
    });

    modal.afterClose(() => modal.destroy());

    // Override the content of the modal, without removing the close button.
    // PicoModal does not allow for native content overwriting.
    modal.setContent = body => {
        Array.from(modal.modalElem().childNodes).forEach(child => {
            if (child !== modal.closeElem()) {
                modal.modalElem().removeChild(child);
            }
        });

        modal.modalElem().insertAdjacentHTML('afterbegin', body);
    };

    modal.addFailure = failure => {
        failures.push(failure);
        modal.setContent(getModalContent());
    };

    modal.addSuccess = () => {
        numLoaded++;
        modal.setContent(getModalContent());
    };

    modal.addDirectoryEntries = (count) => {
        numFiles += count - 1;
        modal.setContent(getModalContent());
    };

    // Show any errors, or close modal if no errors occurred
    modal.finished = () => {
        if (failures.length === 0) {
            return modal.close();
        }

        let failedItems = failures.map(failure => `<li>${failure.name}</li>`);
        modal.setContent(`
            <h1>Files loaded</h1>
            <p>
                Loaded ${numLoaded},
                <span class="failures">
                    ${failures.length} failure${failures.length === 1 ? '' : 's'}:
                </span>
            </p>
            <ul class="failures">${failedItems.join('')}</ul>`);
        // enable all the methods of closing the window
        modal.closeElem().style.display = '';
        modal.options({
            escCloses: true,
            overlayClose: true,
        });
    };

    return modal;
}


export function buildSettingsModal(tracks, opts, updateCallback) {
    let overrideExisting = opts.lineOptions.overrideExisting ? 'checked' : '';

    if (tracks.length > 0) {
        let allSameColor = tracks.every(({line}) => {
            return line.options.color === tracks[0].line.options.color;
        });

        if (allSameColor) {
            opts.lineOptions.color = tracks[0].line.options.color;
        }
    }

    let themes = AVAILABLE_THEMES.map(t => {
        let selected = (t === opts.theme) ? 'selected' : '';
        return `<option ${selected} value="${t}">${t}</option>`;
    });

    let newDate = opts.newDate;
    let maxDate = new Date().toISOString().split('T')[0];

    let modalContent = `
<h3>Options</h3>

<form id="settings">
    <span class="form-row">
        <label>Theme</label>
        <select name="theme">
            ${themes}
        </select>
    </span>

    <fieldset class="form-group">
        <legend>GPS Track Options</legend>

        <div class="row">
            <input name="colorMode" type="radio" id="singleColor" value="singleColor">
            <label for="singleColor">Single color</label>
            <input name="color" type="color" value=${opts.lineOptions.color}>
            <br/>
            <input name="colorMode" type="radio" id="detectColors" value="detectColors">
            <label for="detectColors">Color based on activity type</label>
            <br/>
            <input name="colorMode" type="radio" id="highlightNew" value="highlightNew">
            <label for="highlightNew">Highlight new activities</label>
            <input type="date" id="newDate" value="${newDate || ''}" min="1990-01-01" max="${maxDate}">
        </div>

        <div class="row">
            <label>Opacity</label>
            <input name="opacity" type="range" min=0 max=1 step=0.01
                value=${opts.lineOptions.opacity}>
        </div>

        <div class="row">
            <label>Width</label>
            <input name="weight" type="number" min=1 max=100
                value=${opts.lineOptions.weight}>
        </div>

    </fieldset>

    <fieldset class="form-group">
        <legend>Image Marker Options</legend>

        <div class="row">
            <label>Color</label>
            <input name="markerColor" type="color" value=${opts.markerOptions.color}>
        </div>

        <div class="row">
            <label>Opacity</label>
            <input name="markerOpacity" type="range" min=0 max=1 step=0.01
                value=${opts.markerOptions.opacity}>
        </div>

        <div class="row">
            <label>Width</label>
            <input name="markerWeight" type="number" min=1 max=100
                value=${opts.markerOptions.weight}>
        </div>

        <div class="row">
            <label>Radius</label>
            <input name="markerRadius" type="number" min=1 max=100
                value=${opts.markerOptions.radius}>
        </div>

    </fieldset>

    <fieldset class="form-group">
        <legend>Animation</legend>

        <div class="row">
            <label>Playback Rate</label>
            <input name="playbackRate" type="number" value=${opts.animationOptions.playbackRate}>
        </div>

        <div class="row">
            <label title="Animate all tracks simultaneously"><input name="animationMode" type="radio" value="simultaneous" /> Simultaneous</label>
            <br/>
            <label title="Synchronize animation by timestamps"><input name="animationMode" type="radio" value="synchronized" /> Synchronized (group ride)</label>
            <br/>
            <label title="Animate only latest track"><input name="animationMode" type="radio" value="latest" /> Latest</label>
        </div>

    </fieldset>

    <span class="form-row">
        <label>Override existing tracks</label>
        <input name="overrideExisting" type="checkbox" ${overrideExisting}>
    </span>
</form>`;

    let modal = picoModal({
        content: modalContent,
        closeButton: true,
        escCloses: true,
        overlayClose: true,
        overlayStyles: (styles) => {
            styles.opacity = 0.1;
        },
    });

    let applyOptions = () => {
        let elements = document.getElementById('settings').elements;
        let options = Object.assign({}, opts);

        for (let opt of ['theme', 'newDate']) {
            options[opt] = elements[opt].value;
        }

        for (let opt of ['color', 'weight', 'opacity']) {
            options.lineOptions[opt] = elements[opt].value;
        }

        for (let opt of ['markerColor', 'markerWeight', 'markerOpacity', 'markerRadius']) {
            let optionName = opt.replace('marker', '').toLowerCase();
            options.markerOptions[optionName] = elements[opt].value;
        }

        for (let opt of ['overrideExisting']) {
            options.lineOptions[opt] = elements[opt].checked;
        }

        for (let opt of ['playbackRate']) {
            options.animationOptions[opt] = elements[opt].value;
        }

        options.lineOptions.colorMode = elements.namedItem('colorMode').value;
        options.animationOptions.mode = elements.namedItem('animationMode').value;

        updateCallback(options);
    };

    modal.afterClose((modal) => {
        applyOptions();
        modal.destroy();
    });

    modal.afterCreate(() => {
        let elements = document.getElementById('settings').elements;
    
        elements.namedItem('colorMode').value = opts.lineOptions.colorMode;
        elements.namedItem('animationMode').value = opts.animationOptions.mode;

        for (let opt of ['theme', 'color', 'weight', 'opacity', 'markerColor',
                        'markerWeight', 'markerOpacity', 'markerRadius',
                        'newDate', 'detectColors', 'singleColor', 'highlightNew']) {
            elements[opt].addEventListener('change', applyOptions);
        }
    });

    return modal;
}

export function buildFilterModal(tracks, filters, finishCallback) {
    let maxDate = new Date().toISOString().split('T')[0];
    let showCycling = filters.showCycling ? 'checked' : '';
    let showRunning = filters.showRunning ? 'checked' : '';
    let showOther = filters.showOther ? 'checked' : '';
    let modalContent = `
<h3>Filter Displayed Tracks</h3>

<form id="settings">
    <fieldset class="form-group">
        <legend>Date</legend>

        <span class="form-row">
            <label for="minDate">Start:</label>
            <input type="date" id="minDate" name="minDate"
                value="${filters.minDate || ''}"
                min="1990-01-01"
                max="${maxDate}">
        </span>

        <span class="form-row">
            <label for="maxDate">End:</label>
            <input type="date" id="maxDate" name="maxDate"
                value="${filters.maxDate || ''}"
                min="1990-01-01"
                max="${maxDate}">
        </span>
    </fieldset>

    <fieldset>
        <legend>Activity Type</legend>

        <span class="form-row">
            <label>Cycling</label>
            <input name="showCycling" type="checkbox" ${showCycling}>
        </span>

        <span class="form-row">
            <label>Running</label>
            <input name="showRunning" type="checkbox" ${showRunning}>
        </span>

        <span class="form-row">
            <label>Other</label>
            <input name="showOther" type="checkbox" ${showOther}>
        </span>
    </fieldset>
</form>`;

    let modal = picoModal({
        content: modalContent,
        closeButton: true,
        escCloses: true,
        overlayClose: true,
        overlayStyles: (styles) => {
            styles.opacity = 0.1;
        },
    });

    modal.afterClose((modal) => {
        let elements = document.getElementById('settings').elements;
        let filters = Object.assign({});

        for (let key of ['minDate', 'maxDate']) {
            filters[key] = elements[key].value;
        }

        for (let key of ['showCycling', 'showRunning', 'showOther'])
        {
            filters[key] = elements[key].checked;
        }

        finishCallback(filters);
        modal.destroy();
    });

    return modal;
}

export function showModal(type) {
    let modal = picoModal({
        content: MODAL_CONTENT[type],
        overlayStyles: (styles) => {
            styles.opacity = 0.01;
        },
    });

    modal.show();
    return modal;
}


const INTRO_MODAL_SEEN_KEY = 'intro-modal-seen';

export function initialize(map) {
    // We don't need to show the help modal every time, only the first
    // time the user sees the page.
    let displayIntroModal = true;

    if (window.sessionStorage.getItem(INTRO_MODAL_SEEN_KEY) !== null) {
        displayIntroModal = false;
    } else {
        window.sessionStorage.setItem(INTRO_MODAL_SEEN_KEY, 'true');
    }


    let modal = displayIntroModal ? showModal('help') : null;

    window.addEventListener('dragover', handleDragOver, false);
    window.addEventListener('drop', e => {
        if (displayIntroModal && !modal.destroyed) {
            modal.destroy();
            modal.destroyed = true;
        }
        handleFileSelect(map, e);
    }, false);
}
