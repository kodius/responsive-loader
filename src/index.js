// @flow

const path = require('path');
const loaderUtils = require('loader-utils');

const MIMES = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'webp': 'image/webp'
};

const EXTS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

type Config = {
  size: string | number | void,
  sizes: [string | number] | void,
  min: string | number | void,
  max: string | number | void,
  steps: string | number | void,
  name: string | void,
  outputPath: Function | string | void,
  publicPath: Function | string | void,
  context: string | void,
  placeholderSize: string | number | void,
  quality: string | number | void,
  background: string | number | void,
  placeholder: string | boolean | void,
  adapter: ?Function,
  format: 'png' | 'jpg' | 'jpeg' | 'webp',
  disable: ?boolean,
};

const getOutputAndPublicPath = (fileName:string, {outputPath: configOutputPath, publicPath: configPublicPath}:Config) => {
  let outputPath = fileName;

  if (configOutputPath) {
    if (typeof configOutputPath === 'function') {
      outputPath = configOutputPath(fileName);
    } else {
      outputPath = path.posix.join(configOutputPath, fileName);
    }
  }

  let publicPath = `__webpack_public_path__ + ${JSON.stringify(outputPath)}`;

  if (configPublicPath) {
    if (typeof configPublicPath === 'function') {
      publicPath = configPublicPath(fileName);
    } else if (configPublicPath.endsWith('/')) {
      publicPath = configPublicPath + fileName;
    } else {
      publicPath = `${configPublicPath}/${fileName}`;
    }

    publicPath = JSON.stringify(publicPath);
  }

  return {
    outputPath,
    publicPath
  };
};

module.exports = function loader(content: Buffer) {
  const loaderCallback = this.async();
  const parsedResourceQuery = this.resourceQuery ? loaderUtils.parseQuery(this.resourceQuery) : {};
  const config: Config = Object.assign({}, loaderUtils.getOptions(this), parsedResourceQuery);
  const outputContext: string = config.context || this.rootContext || this.options && this.options.context;
  const outputPlaceholder: boolean = Boolean(config.placeholder) || false;
  const placeholderSize: number = parseInt(config.placeholderSize, 10) || 40;
  // JPEG and WEBP compression
  const quality: number = parseInt(config.quality, 10) || 85;
  // Useful when converting from PNG to JPG
  const background: string | number | void = config.background;
  // Specify mimetype to convert to another format
  let mime: string;
  let ext: string;
  if (config.format) {
    if (!MIMES.hasOwnProperty(config.format)) {
      return loaderCallback(new Error('Format "' + config.format + '" not supported'));
    }
    mime = MIMES[config.format];
    ext = EXTS[mime];
  } else {
    ext = path.extname(this.resourcePath).replace(/\./, '');
    mime = MIMES[ext];
    if (!mime) {
      return loaderCallback(new Error('No mime type for file with extension ' + ext + 'supported'));
    }
  }

  const name = (config.name || '[hash]-[width].[ext]').replace(/\[ext\]/ig, ext);

  const adapter: Function = config.adapter || require('./adapters/jimp');
  const loaderContext: any = this;

  // The config that is passed to the adatpers
  const adapterOptions = Object.assign({}, config, {
    quality,
    background
  });

  const min: number | void = config.min !== undefined ? parseInt(config.min, 10) : undefined;
  const max: number | void = config.max !== undefined ? parseInt(config.max, 10) : undefined;
  const steps: number = config.steps === undefined ? 4 : parseInt(config.steps, 10);

  let generatedSizes;
  if (typeof min === 'number' && max) {
    generatedSizes = [];

    for (let step = 0; step < steps; step++) {
      const size = min + (max - min) / (steps - 1) * step;
      generatedSizes.push(Math.ceil(size));
    }
  }

  const sizes = parsedResourceQuery.size || parsedResourceQuery.sizes || generatedSizes || config.size || config.sizes || [Number.MAX_SAFE_INTEGER];

  if (!sizes) {
    return loaderCallback(null, content);
  }

  if (config.disable) {
    // emit original content only
    const fileName = loaderUtils.interpolateName(loaderContext, name, {
      context: outputContext,
      content: content
    })
      .replace(/\[width\]/ig, '100')
      .replace(/\[height\]/ig, '100');

    const {outputPath, publicPath} = getOutputAndPublicPath(fileName, config);

    loaderContext.emitFile(outputPath, content);

    return loaderCallback(null, 'module.exports = {srcSet:' + publicPath + ',images:[{path:' + publicPath + ',width:100,height:100}],src: ' + publicPath + ',toString:function(){return ' + publicPath + '}};');
  }

  const createFile = ({data, width, height}) => {
    const fileName = loaderUtils.interpolateName(loaderContext, name, {
      context: outputContext,
      content: data
    })
    .replace(/\[width\]/ig, width)
    .replace(/\[height\]/ig, height);

    const {outputPath, publicPath} = getOutputAndPublicPath(fileName, config);

    loaderContext.emitFile(outputPath, data);

    return {
      src: publicPath + `+${JSON.stringify(` ${width}w`)}`,
      path: publicPath,
      width: width,
      height: height
    };
  };

  const createWebpFile = ({ data, width, height }) => {
    const fileName = loaderUtils.interpolateName(loaderContext, name, {
      context: outputContext,
      content: data
    })
      .replace(/\[width\]/ig, width)
      .replace(/\[height\]/ig, height);

    let fileNameWebp = fileName.replace(/(jpe?g|png|svg|gif)$/ig, 'webp');

    const { outputPath, publicPath } = getOutputAndPublicPath(fileNameWebp, config);

    loaderContext.emitFile(outputPath, data);

    return {
      src: publicPath + `+${JSON.stringify(` ${width}w`)}`,
      path: publicPath,
      width: width,
      height: height
    };
  };

  const createPlaceholder = ({data}: {data: Buffer}) => {
    const placeholder = data.toString('base64');
    return JSON.stringify('data:' + (mime ? mime + ';' : '') + 'base64,' + placeholder);
  };

  const img = adapter(loaderContext.resourcePath);
  return img.metadata()
    .then((metadata) => {
      let promises = [];
      const widthsToGenerate = new Set();
      let adapterWebpOptions = adapterOptions;
      adapterWebpOptions['format'] = "webp";

      (Array.isArray(sizes) ? sizes : [sizes]).forEach((size) => {
        const width = Math.min(metadata.width, parseInt(size, 10));

        // Only resize images if they aren't an exact copy of one already being resized...
        if (!widthsToGenerate.has(width)) {
          widthsToGenerate.add(width);
          promises.push(img.resize({
            width,
            mime,
            options: adapterOptions
          }));

          promises.push(img.resize({
            width,
            'webp': 'image/webp',
            options: adapterWebpOptions
          }).toFormat('webp'));
        }
      });

      if (outputPlaceholder) {
        promises.push(img.resize({
          width: placeholderSize,
          options: adapterOptions,
          mime
        }));
      }

      return Promise.all(promises)
        .then(results => outputPlaceholder
          ? {
            files: results.slice(0, -1).map(createFile),
            webpFiles: results.slice(0, -1).map(createWebpFile),
            placeholder: createPlaceholder(results[results.length - 1])
          }
          : {
            files: results.map(createFile),
            webpFiles: results.slice(0, -1).map(createWebpFile),
          }
         );
    })
    .then(({ files, webpFiles, placeholder}) => {
      const srcset = files.map(f => f.src).join('+","+');
      const srcsetWebp = webpFiles.map(f => f.src).join('+","+');

      const images = files.map(f => '{path:' + f.path + ',width:' + f.width + ',height:' + f.height + '}').join(',');

      const firstImage = files[0];

      loaderCallback(null, 'module.exports = {' +
          'srcSetWebP:' + srcsetWebp + ',' +
          'srcSet:' + srcset + ',' +
          'images:[' + images + '],' +
          'src:' + firstImage.path + ',' +
          'toString:function(){return ' + firstImage.path + '},' +
          'placeholder: ' + placeholder + ',' +
          'width:' + firstImage.width + ',' +
          'height:' + firstImage.height +
      '};');
    })
    .catch(err => loaderCallback(err));
};

module.exports.raw = true; // get buffer stream instead of :wutf8 string
