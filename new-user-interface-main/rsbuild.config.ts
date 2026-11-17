import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

const fs = require('fs');
const path = require('path');

const siteId = process.env.REEF_SITE_ID || '';
const siteDir = siteId ? path.resolve(__dirname, `../sites/${siteId}`) : '';
const siteConfigFile = siteDir ? path.join(siteDir, 'site.config.json') : '';
const siteFreeBotsDir = siteDir ? path.join(siteDir, 'free-bots') : '';

export default defineConfig({
    plugins: [
        pluginSass({
            sassLoaderOptions: {
                sourceMap: true,
                sassOptions: {},
            },
            exclude: /node_modules/,
        }),
        pluginReact(),
    ],
    source: {
        entry: {
            index: './src/main.tsx',
        },
        define: {
            'process.env': {
                APP_ENV: JSON.stringify(process.env.APP_ENV || 'production'),
                CLIENT_ID: JSON.stringify(process.env.CLIENT_ID),
                APP_ID: JSON.stringify(process.env.APP_ID),
                REDIRECT_URI: JSON.stringify(process.env.REDIRECT_URI || ''),
                REEF_SITE_ID: JSON.stringify(process.env.REEF_SITE_ID || ''),
                REEF_SITE_CONFIG_URL: JSON.stringify(process.env.REEF_SITE_CONFIG_URL || '/site.config.json'),
                SITE_CONFIG_API_BASE_URL: JSON.stringify(process.env.SITE_CONFIG_API_BASE_URL || ''),
                BACKEND_API_URL: JSON.stringify(process.env.BACKEND_API_URL || ''),
                GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID),
                GD_APP_ID: JSON.stringify(process.env.GD_APP_ID),
                GD_API_KEY: JSON.stringify(process.env.GD_API_KEY),
            },
        },
    },
    resolve: {
        alias: {
            react: path.dirname(require.resolve('react/package.json')),
            'react-dom': path.dirname(require.resolve('react-dom/package.json')),
            '@/external': path.resolve(__dirname, './src/external'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/constants': path.resolve(__dirname, './src/constants'),
            '@/stores': path.resolve(__dirname, './src/stores'),
        },
    },
    output: {
        copy: [
            ...(siteConfigFile && fs.existsSync(siteConfigFile)
                ? [
                      {
                          from: siteConfigFile,
                          to: 'site.config.json',
                      },
                  ]
                : []),
            ...(siteFreeBotsDir && fs.existsSync(siteFreeBotsDir)
                ? [
                      {
                          from: path.join(siteFreeBotsDir, '*'),
                          to: 'free-bots/[name][ext]',
                      },
                  ]
                : []),
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/*',
                to: 'js/smartcharts/[name][ext]',
                globOptions: {
                    ignore: ['**/*.LICENSE.txt'],
                },
            },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/*', to: 'assets/[name][ext]' },
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/fonts/*',
                to: 'assets/fonts/[name][ext]',
            },
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/shaders/*',
                to: 'assets/shaders/[name][ext]',
            },
            { from: path.join(__dirname, 'public') },
        ],
    },
    html: {
        template: './index.html',
    },
    server: {
        port: 5000,
        host: '0.0.0.0',
        compress: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
    dev: {
        hmr: true,
        lazyCompilation: false,
        client: {
            host: process.env.REPLIT_DEV_DOMAIN || '',
            port: 443,
            protocol: 'wss',
        },
    },
    performance: {
        bundleAnalyze:
            process.env.BUNDLE_ANALYZE === 'true'
                ? {
                      analyzerMode: 'server',
                      analyzerHost: 'localhost',
                      analyzerPort: 8888,
                      openAnalyzer: true,
                      generateStatsFile: true,
                      statsFilename: 'stats.json',
                  }
                : undefined,
    },
    tools: {
        rspack: {
            plugins: [],
            module: {
                rules: [
                    {
                        test: /\.xml$/,
                        exclude: /node_modules/,
                        use: 'raw-loader',
                    },
                ],
            },
        },
    },
});
