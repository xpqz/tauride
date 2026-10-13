const path = require('node:path');
const lessGlob = require('less-plugin-glob');

module.exports = function gruntTask(grunt) {
  grunt.loadNpmTasks('grunt-contrib-less');
  grunt.initConfig({
    less: {
      development: {
        options: { paths: [path.join(__dirname, 'style', 'less')], plugins: [lessGlob], strictMath: true },
        files: {
          './style/ride-base.css': './style/layout.less',
          './style/dark-theme.css': './style/dark-theme.less',
          './style/light-theme.css': './style/light-theme.less',
        },
      },
    },
  });
  grunt.registerTask('default', ['less']);
};
